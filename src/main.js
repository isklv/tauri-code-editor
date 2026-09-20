import './style.css';

import * as api from './api.js';
import { askConfirm, askFolder, askText, showInfo } from './dialog.js';
import { showMenu } from './contextmenu.js';
import { openPalette } from './palette.js';
import { createDiffEditor, createEditor, createModel, fixAndroidComposition, monaco, setupCompletions } from './editor.js';
import { FileTree } from './filetree.js';
import { TerminalPanel } from './terminal.js';
import { GitPanel } from './gitpanel.js';
import { getFileIconHtml, SVG_ICONS } from './icons.js';

// ── Layout ──

document.getElementById('app').innerHTML = `
  <div class="workbench">
    <!-- Desktop Activity Bar (VS Code style left rail) -->
    <nav class="activity-bar" id="activity-bar">
      <div class="activity-top">
        <button class="activity-item active" id="act-explorer" data-view="explorer" title="Explorer (Ctrl+Shift+E)">
          ${SVG_ICONS.explorer}
        </button>
        <button class="activity-item" id="act-search" data-view="search" title="Search Files (Ctrl+Shift+F)">
          ${SVG_ICONS.search}
        </button>
        <button class="activity-item" id="act-git" data-view="git" title="Source Control & GitHub (Ctrl+Shift+G)">
          ${SVG_ICONS.git}
          <span class="activity-badge" id="git-badge" style="display:none">0</span>
        </button>
      </div>
      <div class="activity-bottom">
        <button class="activity-item" id="act-terminal" title="Toggle Terminal (Ctrl+\`)">
          ${SVG_ICONS.terminal}
        </button>
        <button class="activity-item" id="act-github" title="GitHub & Account">
          ${SVG_ICONS.github}
        </button>
      </div>
    </nav>

    <!-- Sidebar with multiple views -->
    <aside class="sidebar" id="sidebar">
      <!-- Explorer View -->
      <div class="sidebar-view" id="view-explorer">
        <div class="sidebar-header">
          <span class="title" id="root-name">Explorer</span>
          <button class="icon-button" id="btn-up" title="Go to parent folder">↑</button>
          <button class="icon-button" id="btn-new-file" title="New file">＋</button>
          <button class="icon-button" id="btn-refresh" title="Refresh">⟳</button>
        </div>
        <div class="sidebar-path" id="root-path"></div>
        <div class="file-tree" id="file-tree"></div>
      </div>

      <!-- Search View -->
      <div class="sidebar-view" id="view-search" style="display:none;">
        <div class="sidebar-header">
          <span class="title">Search Files</span>
          <button class="icon-button" id="btn-refresh-search" title="Clear search">×</button>
        </div>
        <div class="search-panel">
          <input type="text" class="search-input" id="search-query" placeholder="Type filename to search..." />
          <div class="search-results" id="search-results">
            <div style="padding:12px; color:var(--fg-dim); text-align:center;">Type a query above to search files</div>
          </div>
        </div>
      </div>

      <!-- Source Control / Git View -->
      <div class="sidebar-view" id="view-git" style="display:none;">
        <div class="sidebar-header">
          <span class="title">Source Control</span>
        </div>
        <div class="git-panel-host" id="git-panel-host"></div>
      </div>
    </aside>

    <div class="resizer-v" id="resizer-sidebar"></div>
    <div class="scrim" id="scrim"></div>

    <main class="main">
      <!-- Sleek Modern Header / Command Bar -->
      <header class="topbar" id="topbar">
        <div class="topbar-left">
          <button class="icon-button topbar-btn" id="btn-menu" title="Toggle Sidebar (Ctrl+B)">
            ${SVG_ICONS.menu}
          </button>
          <span class="topbar-brand" title="Geko - Code on the go" style="display:inline-flex;align-items:center;margin:0 2px;cursor:default;">
            ${SVG_ICONS.geko}
          </span>
          <button class="topbar-workspace-btn" id="btn-open" title="Open folder">
            <span class="topbar-ws-icon">${SVG_ICONS.folder}</span>
            <span class="topbar-ws-title" id="topbar-root-name">Open Folder</span>
            <span class="topbar-ws-chevron">${SVG_ICONS.chevronDown}</span>
          </button>
        </div>

        <div class="topbar-center">
          <button class="quick-open-pill" id="btn-goto" title="Search files (Ctrl+P)">
            <span class="quick-open-icon">${SVG_ICONS.search}</span>
            <span class="quick-open-text" id="quick-open-label">Go to file...</span>
            <kbd class="quick-open-kbd">Ctrl P</kbd>
          </button>
        </div>

        <div class="topbar-right">
          <button class="icon-button topbar-btn" id="btn-save" title="Save file (Ctrl+S)">
            ${SVG_ICONS.save}
          </button>
          <button class="icon-button topbar-btn" id="btn-toggle-terminal" title="Toggle Terminal (Ctrl+\`)">
            ${SVG_ICONS.terminal}
          </button>
          <button class="icon-button topbar-btn" id="btn-clone-toolbar" title="GitHub Clone & Repos">
            ${SVG_ICONS.github}
          </button>
          <button class="topbar-linux-badge not-installed" id="topbar-linux-badge" title="Linux Environment">
            🐧 <span id="topbar-linux-text">Linux</span>
          </button>
        </div>
      </header>

      <div class="tabbar" id="tabbar"></div>

      <!-- Breadcrumbs bar -->
      <div class="breadcrumbs-bar" id="breadcrumbs" style="display:none;"></div>

      <div class="editor-container" id="editor-container">
        <div class="editor" id="editor"></div>
        <div class="diff-editor" id="diff-editor" style="display:none;">
          <div class="diff-header">
            <span class="diff-title" id="diff-title">Diff View</span>
            <button class="icon-button" id="btn-close-diff" title="Close Diff View">×</button>
          </div>
          <div class="diff-host" id="diff-host"></div>
        </div>
      </div>

      <div class="resizer-h" id="resizer-panel"></div>
      <section class="panel" id="panel">
        <div class="panel-header">
          <span>Terminal</span>
          <button class="panel-pill" id="btn-install-linux" title="Install Alpine Linux + apk package manager">🐧 Install Linux</button>
          <select class="panel-select" id="select-shell" style="display:none" title="Choose shell environment">
            <option value="alpine">🐧 Alpine Linux (apk)</option>
            <option value="native">📱 Native Shell</option>
            <option value="reinstall">🔄 Reinstall Linux</option>
          </select>
          <span class="spacer"></span>
          <button class="icon-button" id="btn-linux-log" title="Show Linux setup log">🧾</button>
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
        <pre class="linux-log" id="linux-log" style="display:none"></pre>
        <div class="terminal-host" id="terminal"></div>
        <div class="term-keys" id="term-keys"></div>
      </section>
    </main>
  </div>

  <!-- Mobile Bottom Navigation Bar (Thumb-friendly, visible on <= 700px) -->
  <nav class="mobile-nav" id="mobile-nav">
    <button class="mobile-nav-item active" id="mob-act-explorer" data-view="explorer" title="Files">
      <span class="mobile-nav-icon">${SVG_ICONS.explorer}</span>
      <span class="mobile-nav-label">Files</span>
    </button>
    <button class="mobile-nav-item" id="mob-act-search" data-view="search" title="Search">
      <span class="mobile-nav-icon">${SVG_ICONS.search}</span>
      <span class="mobile-nav-label">Search</span>
    </button>
    <button class="mobile-nav-item" id="mob-act-git" data-view="git" title="Git">
      <span class="mobile-nav-icon">
        ${SVG_ICONS.git}
        <span class="mobile-badge" id="mob-git-badge" style="display:none">0</span>
      </span>
      <span class="mobile-nav-label">Git</span>
    </button>
    <button class="mobile-nav-item" id="mob-act-terminal" title="Terminal">
      <span class="mobile-nav-icon">${SVG_ICONS.terminal}</span>
      <span class="mobile-nav-label">Terminal</span>
    </button>
    <button class="mobile-nav-item" id="mob-act-github" title="GitHub">
      <span class="mobile-nav-icon">${SVG_ICONS.github}</span>
      <span class="mobile-nav-label">GitHub</span>
    </button>
  </nav>

  <footer class="statusbar">
    <button class="statusbar-item statusbar-git" id="status-git-branch" style="display:none;" title="Git Branch (click to switch or create)">
      ${SVG_ICONS.branch} <span id="status-branch-name">main</span>
    </button>
    <button class="statusbar-item statusbar-sync" id="status-git-sync" style="display:none;" title="Sync Changes (Pull & Push)">
      ${SVG_ICONS.sync} <span id="status-sync-counts">0↓ 0↑</span>
    </button>
    <span class="statusbar-item message" id="status-message">Ready</span>
    <span class="spacer"></span>
    <span class="statusbar-item" id="status-position"></span>
    <span class="statusbar-item" id="status-encoding">UTF-8</span>
    <span class="statusbar-item" id="status-indent">Spaces: 2</span>
    <span class="statusbar-item" id="status-language"></span>
    <button class="statusbar-item" id="status-version" style="background:none;border:none;color:inherit;cursor:pointer;" title="Click for build info"></button>
  </footer>
`;

const $ = (id) => document.getElementById(id);

// ── State ──

/** @type {Map<string, {model: any, viewState: any, saved: string}>} */
const openFiles = new Map();
let activePath = null;
let rootPath = null;
let statusTimer = null;
let currentView = 'explorer';

const editor = createEditor($('editor'));
const diffEditor = createDiffEditor($('diff-host'));
for (const target of [editor, diffEditor.getOriginalEditor(), diffEditor.getModifiedEditor()]) {
  fixAndroidComposition(target);
}
let diffOriginalModel = null;
let diffModifiedModel = null;

const terminal = new TerminalPanel($('terminal'), $('term-keys'));
const tree = new FileTree($('file-tree'), {
  onOpenFile: async (path) => {
    closeDiff();
    await openFile(path);
    if (isNarrow()) setSidebar(false);
  },
  onError: (msg) => setStatus(msg, true),
  onContextMenu: (entry, x, y) => showEntryMenu(entry, x, y),
});

const gitPanel = new GitPanel($('git-panel-host'), {
  getRoot: () => rootPath,
  onOpenFile: async (path) => {
    closeDiff();
    await openFile(path);
    if (isNarrow()) setSidebar(false);
  },
  onOpenDiff: async (file) => {
    await openDiff(file);
    if (isNarrow()) setSidebar(false);
  },
  onFolderChanged: async (newRoot) => {
    await openFolder(newRoot);
    await terminal.restart(newRoot, currentShellMode);
  },
  onError: (msg) => setStatus(msg, true),
  onStatusUpdated: (status) => updateGitStatus(status),
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
    if (currentView === 'git') {
      gitPanel.refresh();
    }
  }, delay);
}

api.onFsChange(() => {
  scheduleTreeRefresh();
});

window.addEventListener('focus', async () => {
  if (!rootPath) {
    try {
      const def = await api.defaultRoot();
      if (def) await openFolder(def);
    } catch {}
  }
  scheduleTreeRefresh(50);
});

setInterval(() => {
  if (document.visibilityState === 'visible' && rootPath) {
    tree.refresh();
    if (currentView === 'git') {
      gitPanel.refresh();
    }
  }
}, 5000);

// ── Activity Bar Navigation ──

function setSidebarView(viewName) {
  const isOpen = document.body.classList.contains('sidebar-open');
  if (currentView === viewName && isOpen) {
    setSidebar(false);
    return;
  }

  currentView = viewName;
  document.querySelectorAll('.activity-item[data-view], .mobile-nav-item[data-view]').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-view') === viewName);
  });

  ['explorer', 'search', 'git'].forEach((v) => {
    const viewEl = $(`view-${v}`);
    if (viewEl) viewEl.style.display = v === viewName ? 'flex' : 'none';
  });

  if (viewName === 'git') {
    gitPanel.refresh();
  } else if (viewName === 'search') {
    setTimeout(() => $('search-query')?.focus(), 50);
  }

  setSidebar(true);
}

$('act-explorer')?.addEventListener('click', () => setSidebarView('explorer'));
$('act-search')?.addEventListener('click', () => setSidebarView('search'));
$('act-git')?.addEventListener('click', () => setSidebarView('git'));
$('act-terminal')?.addEventListener('click', () => toggleTerminal());
$('act-github')?.addEventListener('click', () => gitPanel.showGitHubModal());
$('btn-clone-toolbar')?.addEventListener('click', () => gitPanel.showCloneModal());

// Mobile Bottom Nav handlers
$('mob-act-explorer')?.addEventListener('click', () => {
  if (currentView === 'explorer' && document.body.classList.contains('sidebar-open')) {
    setSidebar(false);
  } else {
    setSidebarView('explorer');
  }
});
$('mob-act-search')?.addEventListener('click', () => {
  if (currentView === 'search' && document.body.classList.contains('sidebar-open')) {
    setSidebar(false);
  } else {
    setSidebarView('search');
  }
});
$('mob-act-git')?.addEventListener('click', () => {
  if (currentView === 'git' && document.body.classList.contains('sidebar-open')) {
    setSidebar(false);
  } else {
    setSidebarView('git');
  }
});
$('mob-act-terminal')?.addEventListener('click', () => toggleTerminal());
$('mob-act-github')?.addEventListener('click', () => gitPanel.showGitHubModal());

// ── Search View Implementation ──

let searchDebounce = null;
$('search-query')?.addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  const query = e.target.value.trim();
  searchDebounce = setTimeout(async () => {
    if (!rootPath || !query) {
      $('search-results').innerHTML = '<div style="padding:12px; color:var(--fg-dim); text-align:center;">Type filename to search...</div>';
      return;
    }
    try {
      const results = await api.findFiles(rootPath, query);
      const host = $('search-results');
      host.innerHTML = '';
      if (results.length === 0) {
        host.innerHTML = '<div style="padding:12px; color:var(--fg-dim); text-align:center;">No files found</div>';
        return;
      }
      for (const file of results.slice(0, 60)) {
        const row = document.createElement('div');
        row.className = 'search-result-item';
        const base = api.basename(file);
        const dir = api.dirname(file);
        row.innerHTML = `
          <span class="tab-icon">${getFileIconHtml(base)}</span>
          <span class="search-result-name">${base}</span>
          <span class="search-result-path">${dir}</span>
        `;
        row.addEventListener('click', () => {
          closeDiff();
          openFile(file);
          if (isNarrow()) setSidebar(false);
        });
        host.appendChild(row);
      }
    } catch (err) {
      $('search-results').innerHTML = `<div style="padding:8px; color:var(--error);">${err}</div>`;
    }
  }, 200);
});

$('btn-refresh-search')?.addEventListener('click', () => {
  const q = $('search-query');
  if (q) {
    q.value = '';
    $('search-results').innerHTML = '<div style="padding:12px; color:var(--fg-dim); text-align:center;">Type a query above to search files</div>';
  }
});

// ── Diff Viewer ──

async function openDiff(file) {
  try {
    let origText = '';
    if (file.status !== 'untracked' && file.status !== 'added') {
      try {
        origText = await api.gitShowFile(rootPath, file.path, file.staged ? 'HEAD' : null);
      } catch {
        origText = '';
      }
    }

    let currText = '';
    try {
      currText = await api.readFile(file.full_path);
    } catch {
      currText = '';
    }

    if (diffOriginalModel) diffOriginalModel.dispose();
    if (diffModifiedModel) diffModifiedModel.dispose();

    diffOriginalModel = createModel(origText, file.path);
    diffModifiedModel = createModel(currText, file.path);

    diffEditor.setModel({
      original: diffOriginalModel,
      modified: diffModifiedModel,
    });

    $('diff-title').textContent = `${api.basename(file.path)} (${file.staged ? 'Index ↔ HEAD' : 'Working Tree ↔ Index'})`;
    $('diff-editor').style.display = 'flex';
    $('editor').style.display = 'none';
  } catch (e) {
    setStatus(`Cannot open diff: ${e}`, true);
  }
}

function closeDiff() {
  $('diff-editor').style.display = 'none';
  $('editor').style.display = 'block';
  if (diffOriginalModel) {
    diffOriginalModel.dispose();
    diffOriginalModel = null;
  }
  if (diffModifiedModel) {
    diffModifiedModel.dispose();
    diffModifiedModel = null;
  }
  editor.focus();
}

$('btn-close-diff')?.addEventListener('click', closeDiff);

// ── Git Status & Status Bar ──

function updateGitStatus(status) {
  const branchPill = $('status-git-branch');
  const branchName = $('status-branch-name');
  const syncPill = $('status-git-sync');
  const syncCounts = $('status-sync-counts');
  const gitBadge = $('git-badge');
  const mobBadge = $('mob-git-badge');

  if (status && status.is_repo) {
    branchPill.style.display = 'inline-flex';
    branchName.textContent = status.branch || 'HEAD';
    syncPill.style.display = 'inline-flex';
    syncCounts.textContent = `${status.behind}↓ ${status.ahead}↑`;

    const count = status.total_changes;
    if (count > 0) {
      const text = count > 99 ? '99+' : String(count);
      if (gitBadge) {
        gitBadge.style.display = 'block';
        gitBadge.textContent = text;
      }
      if (mobBadge) {
        mobBadge.style.display = 'block';
        mobBadge.textContent = text;
      }
    } else {
      if (gitBadge) gitBadge.style.display = 'none';
      if (mobBadge) mobBadge.style.display = 'none';
    }
  } else {
    branchPill.style.display = 'none';
    syncPill.style.display = 'none';
    if (gitBadge) gitBadge.style.display = 'none';
    if (mobBadge) mobBadge.style.display = 'none';
  }
}

$('status-git-branch')?.addEventListener('click', () => gitPanel.switchBranch());
$('status-git-sync')?.addEventListener('click', async () => {
  if (gitPanel.status?.behind > 0) await gitPanel.pull();
  if (gitPanel.status?.ahead > 0) await gitPanel.push();
});

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
  updateBreadcrumbs();
}

editor.onDidChangeCursorPosition((e) => {
  $('status-position').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
});

// ── Breadcrumbs ──

function updateBreadcrumbs() {
  const container = $('breadcrumbs');
  if (!container) return;
  container.textContent = '';
  if (!activePath) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';
  const rootName = rootPath ? api.folderDisplayName(rootPath) : 'Workspace';
  const rel = rootPath && activePath.startsWith(rootPath)
    ? activePath.slice(rootPath.length).replace(/^[\\/]+/, '')
    : activePath;
  const parts = rel.split(/[\\/]/).filter(Boolean);

  const rootSeg = document.createElement('span');
  rootSeg.className = 'breadcrumb-segment';
  rootSeg.textContent = rootName;
  rootSeg.addEventListener('click', () => setSidebarView('explorer'));
  container.appendChild(rootSeg);

  for (let i = 0; i < parts.length; i++) {
    const sep = document.createElement('span');
    sep.className = 'breadcrumb-sep';
    sep.textContent = '›';
    container.appendChild(sep);

    const seg = document.createElement('span');
    seg.className = 'breadcrumb-segment';
    if (i === parts.length - 1) {
      seg.innerHTML = `${getFileIconHtml(parts[i])} <span>${parts[i]}</span>`;
      seg.style.fontWeight = '500';
      seg.style.color = 'var(--fg)';
    } else {
      seg.textContent = parts[i];
    }
    container.appendChild(seg);
  }
}

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

    const icon = document.createElement('span');
    icon.className = 'tab-icon';
    icon.innerHTML = getFileIconHtml(api.basename(path));
    tab.appendChild(icon);

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

    tab.addEventListener('click', () => {
      closeDiff();
      activate(path);
    });
    bar.appendChild(tab);
  }
}

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
  try {
    localStorage.setItem('geko_last_root', path);
  } catch {}
  const name = api.folderDisplayName(path);
  $('root-name').textContent = name;
  if ($('topbar-root-name')) $('topbar-root-name').textContent = name;
  if ($('quick-open-label')) $('quick-open-label').textContent = `${name} — Go to file...`;
  $('root-path').textContent = path;
  $('root-path').title = path;
  if (activePath) tree.setActive(activePath);
  updateStatus();
  try {
    await api.watchDir(path);
  } catch (e) {
    console.warn('Cannot watch folder:', e);
  }
  gitPanel.refresh();
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

const isNarrow = () => window.matchMedia('(max-width: 700px)').matches;

function setSidebar(open) {
  document.body.classList.toggle('sidebar-open', open);
  if (!open) {
    editor.focus();
    if (isNarrow()) {
      document.querySelectorAll('.mobile-nav-item[data-view]').forEach((el) => {
        el.classList.remove('active');
      });
    }
  } else if (isNarrow()) {
    document.querySelectorAll('.mobile-nav-item[data-view]').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-view') === currentView);
    });
  }
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
    if (isNarrow()) {
      const isKeyboardOpen = document.body.classList.contains('keyboard-open');
      if (isKeyboardOpen && window.visualViewport) {
        const topbarHeight = $('topbar')?.offsetHeight || 42;
        panel.style.height = `${Math.max(120, window.visualViewport.height - topbarHeight)}px`;
      } else {
        panel.style.height = '42vh';
      }
    }
    terminal.fit();
    terminal.focus();
    terminal.term.scrollToBottom();
  } else {
    editor.focus();
  }
}

$('btn-toggle-terminal').addEventListener('click', () => toggleTerminal());
$('btn-close-terminal').addEventListener('click', () => toggleTerminal(true));
$('btn-restart-terminal').addEventListener('click', async () => {
  const mode = currentShellMode === 'native' ? 'native' : 'alpine';
  await startShell(mode);
});

// ── Linux Environment (Alpine + PRoot) ──

let currentShellMode = 'auto';
let autoInstallTried = false;
// Only an install the user asked for is allowed to pop the terminal open; the
// first-launch one finishes in the background without stealing the screen.
let openTerminalAfterInstall = true;

let installWatch = null;
const linuxLogLines = [];

/** Append one setup line to the log box, keeping it scrolled to the newest line. */
function appendLinuxLog(line) {
  linuxLogLines.push(line);
  if (linuxLogLines.length > 300) linuxLogLines.shift();
  const box = $('linux-log');
  if (!box) return;
  box.textContent = linuxLogLines.join('\n');
  if (box.style.display !== 'none') box.scrollTop = box.scrollHeight;
}

function showLinuxLog(visible) {
  const box = $('linux-log');
  if (!box) return;
  box.style.display = visible ? 'block' : 'none';
  if (visible) box.scrollTop = box.scrollHeight;
  terminal.fit();
}


/** Poll while an install runs — it may have been started by the backend before
 * the webview attached its event listeners. */
function watchInstall() {
  if (installWatch) return;
  installWatch = setInterval(async () => {
    const status = await api.getLinuxEnvStatus().catch(() => null);
    if (!status || status.is_installing) return;
    clearInterval(installWatch);
    installWatch = null;
    await updateLinuxEnvUI();
    if (status.is_installed) await linuxEnvReady();
  }, 2000);
}

/** Switch the terminal over to Alpine once the environment exists. */
async function linuxEnvReady() {
  if (currentShellMode === 'native') return;
  currentShellMode = 'alpine';
  const selectShell = $('select-shell');
  if (selectShell) selectShell.value = 'alpine';
  if (openTerminalAfterInstall) {
    toggleTerminal(false);
  }
  await startShell('alpine');
}

async function updateLinuxEnvUI() {
  const btnInstall = $('btn-install-linux');
  const selectShell = $('select-shell');
  const progressBox = $('linux-progress');
  const topbarBadge = $('topbar-linux-badge');
  const topbarText = $('topbar-linux-text');
  if (!btnInstall || !selectShell) return;

  try {
    const status = await api.getLinuxEnvStatus();
    if (status.is_installing) {
      btnInstall.style.display = 'none';
      selectShell.style.display = 'none';
      progressBox.style.display = 'flex';
      if (topbarBadge) {
        topbarBadge.style.display = 'inline-flex';
        topbarBadge.className = 'topbar-linux-badge installing';
        if (topbarText) topbarText.textContent = 'Installing…';
      }
      watchInstall();
    } else if (status.is_installed) {
      btnInstall.style.display = 'none';
      selectShell.style.display = 'inline-block';
      selectShell.value = currentShellMode === 'native' ? 'native' : 'alpine';
      progressBox.style.display = 'none';
      if (topbarBadge) {
        topbarBadge.style.display = 'inline-flex';
        topbarBadge.className = 'topbar-linux-badge installed';
        if (topbarText) topbarText.textContent = 'Alpine';
      }
    } else {
      btnInstall.style.display = 'inline-flex';
      btnInstall.textContent = '🐧 Install Linux';
      selectShell.style.display = 'none';
      progressBox.style.display = 'none';
      if (topbarBadge) {
        topbarBadge.style.display = 'inline-flex';
        topbarBadge.className = 'topbar-linux-badge not-installed';
        if (topbarText) topbarText.textContent = 'Install Linux';
      }
    }
  } catch {
    btnInstall.style.display = 'none';
    selectShell.style.display = 'none';
  }
}

async function triggerInstallLinux({ openTerminal = true } = {}) {
  openTerminalAfterInstall = openTerminal;
  showLinuxLog(openTerminal);
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

/**
 * The Alpine environment is what makes `apk`, git and compilers available, so it
 * is set up on first launch instead of waiting for the user to find the button.
 */
async function ensureLinuxEnv() {
  if (autoInstallTried) return;
  autoInstallTried = true;
  try {
    const status = await api.getLinuxEnvStatus();
    if (status.is_installed) return;
    if (status.is_installing) {
      openTerminalAfterInstall = false;
      watchInstall();
      return;
    }
    setStatus('Setting up Alpine Linux environment (~7 MB)...');
    await triggerInstallLinux({ openTerminal: false });
  } catch {
    // No Tauri backend (browser preview) — nothing to install.
  }
}

$('btn-install-linux')?.addEventListener('click', () => triggerInstallLinux());
$('topbar-linux-badge')?.addEventListener('click', async () => {
  try {
    const status = await api.getLinuxEnvStatus();
    if (status.is_installed) {
      toggleTerminal(false);
    } else if (!status.is_installing) {
      triggerInstallLinux();
    }
  } catch {
    toggleTerminal(false);
  }
});

$('select-shell')?.addEventListener('change', async (e) => {
  if (e.target.value === 'reinstall') {
    e.target.value = currentShellMode === 'native' ? 'native' : 'alpine';
    await reinstallLinuxEnv();
    return;
  }
  await startShell(e.target.value);
});

/** Start the requested shell, dropping back to the native one if Alpine refuses. */
async function startShell(mode) {
  currentShellMode = mode;
  const selectShell = $('select-shell');
  if (await terminal.restart(rootPath, mode)) {
    if (selectShell) selectShell.value = mode;
    return;
  }
  if (mode !== 'alpine') return;
  currentShellMode = 'native';
  if (selectShell) selectShell.value = 'native';
  await terminal.restart(rootPath, 'native');
}

/** Wipe and rebuild the environment — the fix when apk or the shell misbehaves. */
async function reinstallLinuxEnv() {
  try {
    // Detach from the rootfs before deleting it, but keep Alpine as the wanted
    // shell so the terminal returns to it once the new install lands.
    currentShellMode = 'auto';
    await terminal.restart(rootPath, 'native');
    await api.removeLinuxEnv();
    await updateLinuxEnvUI();
    await triggerInstallLinux();
  } catch (err) {
    setStatus(`Reinstall failed: ${err}`, true);
    await updateLinuxEnvUI();
  }
}

api.onLinuxEnvLog((payload) => appendLinuxLog(payload.message));

$('btn-linux-log')?.addEventListener('click', () => {
  const box = $('linux-log');
  if (!box) return;
  if (!linuxLogLines.length) appendLinuxLog('No Linux setup activity yet.');
  const show = box.style.display === 'none';
  if (show) toggleTerminal(false);
  showLinuxLog(show);
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
  setStatus(payload.message || 'Alpine Linux environment ready!', payload.warning === true);
  // A clean install needs no explanation; a warned one does, so its log stays up.
  showLinuxLog(payload.warning === true);
  if (installWatch) {
    clearInterval(installWatch);
    installWatch = null;
  }
  await updateLinuxEnvUI();
  await linuxEnvReady();
});

api.onLinuxEnvFallback((payload) => {
  currentShellMode = 'native';
  const selectShell = $('select-shell');
  if (selectShell) selectShell.value = 'native';
  setStatus(payload.message, true);
});

api.onLinuxEnvError(async (payload) => {
  const progressBox = $('linux-progress');
  if (progressBox) progressBox.style.display = 'none';
  appendLinuxLog(`error: ${payload.message}`);
  toggleTerminal(false);
  showLinuxLog(true);
  setStatus(`Linux setup error: ${payload.message}`, true);
  await updateLinuxEnvUI();
});

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

  const inTerminal = $('terminal').contains(e.target);

  // VS Code global shortcuts
  if (e.shiftKey) {
    if (e.key.toLowerCase() === 'g') {
      e.preventDefault();
      setSidebarView('git');
      return;
    }
    if (e.key.toLowerCase() === 'e') {
      e.preventDefault();
      setSidebarView('explorer');
      return;
    }
    if (e.key.toLowerCase() === 'f') {
      e.preventDefault();
      setSidebarView('search');
      return;
    }
  }

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
  if (picked) {
    closeDiff();
    await openFile(picked);
  }
}

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
  const width = Math.min(Math.max(e.clientX - 48, 150), window.innerWidth * 0.6);
  $('sidebar').style.width = `${width}px`;
});

makeResizer($('resizer-panel'), (e) => {
  const workbench = document.querySelector('.workbench').getBoundingClientRect();
  const height = Math.min(Math.max(workbench.bottom - e.clientY, 60), maxPanelHeight());
  $('panel').style.height = `${height}px`;
  terminal.fit();
});

function isTerminalFocused() {
  const active = document.activeElement;
  return active === terminal?.term?.textarea || $('terminal')?.contains(active);
}

function maxPanelHeight() {
  const main = document.querySelector('.main').getBoundingClientRect().height;
  const chrome = ($('topbar')?.offsetHeight || 38) + ($('tabbar')?.offsetHeight || 35) + ($('resizer-panel')?.offsetHeight || 4);
  const isKeyboardOpen = document.body.classList.contains('keyboard-open');
  const MIN_EDITOR = (isKeyboardOpen && isNarrow() && isTerminalFocused()) ? 0 : 100;
  return Math.max(60, main - chrome - MIN_EDITOR);
}

function clampLayout() {
  const panel = $('panel');
  const maxPanel = maxPanelHeight();
  if (panel.getBoundingClientRect().height > maxPanel) {
    panel.style.height = `${maxPanel}px`;
  }

  const sidebar = $('sidebar');
  const narrow = isNarrow();
  if (narrow) {
    sidebar.style.width = '';
  } else {
    const maxSidebar = Math.max(150, window.innerWidth * 0.6);
    if (sidebar.getBoundingClientRect().width > maxSidebar) {
      sidebar.style.width = `${maxSidebar}px`;
    }
  }

  editor.updateOptions({
    minimap: { enabled: !narrow && window.innerWidth > 900 },
    glyphMargin: !narrow,
    folding: !narrow,
    lineNumbersMinChars: narrow ? 3 : 5,
    lineDecorationsWidth: narrow ? 4 : 10,
  });

  diffEditor.updateOptions({
    renderSideBySide: window.innerWidth > 750,
  });

  terminal.fit();
}

function initViewportKeyboardHandling() {
  if (!window.visualViewport) return;

  const app = $('app');
  const panel = $('panel');

  const onViewportChange = () => {
    const vv = window.visualViewport;
    const isKeyboardOpen = (window.innerHeight - vv.height) > 100;
    document.body.classList.toggle('keyboard-open', isKeyboardOpen);

    // Keep app height matching the visible area above the soft keyboard
    app.style.height = `${vv.height}px`;
    document.documentElement.style.setProperty('--app-height', `${vv.height}px`);

    // Ensure visual viewport isn't panned off-screen
    if (vv.offsetTop > 0) {
      window.scrollTo(0, 0);
    }

    if (!panel.classList.contains('hidden')) {
      if (isKeyboardOpen && isNarrow() && isTerminalFocused()) {
        const topbarHeight = $('topbar')?.offsetHeight || 42;
        const available = Math.max(120, vv.height - topbarHeight);
        panel.style.height = `${available}px`;
      } else if (!isKeyboardOpen && isNarrow()) {
        panel.style.height = '42vh';
      }

      clampLayout();
      terminal.fit();
      terminal.term.scrollToBottom();
    } else {
      clampLayout();
    }
  };

  window.visualViewport.addEventListener('resize', onViewportChange);
  window.visualViewport.addEventListener('scroll', onViewportChange);
}

window.addEventListener('resize', clampLayout);
initViewportKeyboardHandling();

async function initAppInfo() {
  try {
    const info = await api.getAppInfo();
    if (!info) return;
    const vText = `v${info.version}`;
    const commitText = info.commit_hash ? ` (${info.commit_hash})` : '';
    const fullText = `Geko ${vText}${commitText} [${info.build_profile}]`;

    const statusVersion = $('status-version');
    if (statusVersion) {
      statusVersion.textContent = `${vText}${commitText}`;
      statusVersion.title = `${fullText} on ${info.target_os} (${info.target_arch})\nClick for build details`;
      statusVersion.addEventListener('click', () => {
        showInfo('About Geko',
          `Geko Code Editor\n` +
          `Version: ${info.version}\n` +
          (info.commit_hash ? `Commit: ${info.commit_hash}\n` : '') +
          `Profile: ${info.build_profile}\n` +
          `Platform: ${info.target_os} (${info.target_arch})\n` +
          `Runtime: ${api.isTauri ? 'Tauri 2 (Native)' : 'Web Browser'}`
        );
      });
    }

    const brand = document.querySelector('.topbar-brand');
    if (brand) {
      brand.title = `${fullText}\nClick for details`;
      brand.style.cursor = 'pointer';
      brand.addEventListener('click', () => {
        showInfo('About Geko',
          `Geko Code Editor\n` +
          `Version: ${info.version}\n` +
          (info.commit_hash ? `Commit: ${info.commit_hash}\n` : '') +
          `Profile: ${info.build_profile}\n` +
          `Platform: ${info.target_os} (${info.target_arch})\n` +
          `Runtime: ${api.isTauri ? 'Tauri 2 (Native)' : 'Web Browser'}`
        );
      });
    }
  } catch (err) {
    console.warn('Could not load app info:', err);
  }
}

async function init() {
  setSidebar(!isNarrow());
  const savedRoot = localStorage.getItem('geko_last_root');
  let opened = false;
  if (savedRoot) {
    try {
      opened = await openFolder(savedRoot);
    } catch {
      opened = false;
    }
  }
  if (!opened) {
    try {
      const defRoot = await api.defaultRoot();
      await openFolder(defRoot);
    } catch (e) {
      setStatus(`Cannot determine a starting folder: ${e}`, true);
    }
  }

  // If no file is open, try to open README.md or the first file in the opened directory
  if (openFiles.size === 0 && rootPath) {
    try {
      const listing = await api.listDir(rootPath);
      const readme = listing.entries?.find((e) => !e.is_dir && e.name.toLowerCase() === 'readme.md');
      const firstFile = readme || listing.entries?.find((e) => !e.is_dir);
      if (firstFile) {
        await openFile(firstFile.path);
      }
    } catch (e) {
      console.warn('Could not auto-open starter file:', e);
    }
  }

  await updateLinuxEnvUI();
  await terminal.start(rootPath, currentShellMode);
  ensureLinuxEnv();
  renderTabs();
  updateStatus();
  clampLayout();
  initAppInfo();
}

init();
