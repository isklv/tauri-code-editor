import * as monaco from 'monaco-editor';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import 'monaco-editor/min/vs/editor/editor.main.css';
import '@xterm/xterm/css/xterm.css';

// ── State ──
const state = {
  files: new Map(),
  activeFile: null,
  editor: null,
  terminal: null,
};

// ── DOM setup ──
const root = document.getElementById('root');

root.innerHTML = `
  <div style="display:flex;height:100vh;">
    <!-- Sidebar -->
    <div id="sidebar" style="width:250px;background:#252526;border-right:1px solid #3c3c3c;display:flex;flex-direction:column;overflow:hidden;">
      <div style="padding:10px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#858585;user-select:none;">
        Explorer
      </div>
      <div id="file-tree" style="flex:1;overflow-y:auto;padding:0 10px;"></div>
    </div>

    <!-- Main area -->
    <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;">
      <!-- Tab bar -->
      <div style="height:35px;background:#2d2d2d;display:flex;align-items:center;border-bottom:1px solid #3c3c3c;overflow-x:auto;">
        <div id="tabs" style="display:flex;height:100%;"></div>
      </div>

      <!-- Editor + Terminal split -->
      <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;">
        <div id="editor-container" style="flex:1;min-height:100px;"></div>
        <div id="terminal-container" style="height:200px;border-top:1px solid #3c3c3c;display:flex;flex-direction:column;">
          <div style="display:flex;align-items:center;padding:4px 10px;background:#2d2d2d;">
            <span style="font-size:11px;color:#858585;">TERMINAL</span>
            <button id="terminal-close" style="margin-left:auto;background:none;border:none;color:#858585;cursor:pointer;font-size:16px;">×</button>
          </div>
          <div id="terminal" style="flex:1;padding:4px;overflow:hidden;"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Status bar -->
  <div style="height:22px;background:#007acc;display:flex;align-items:center;padding:0 10px;font-size:12px;color:white;user-select:none;">
    <span id="status-left">Ready</span>
    <span style="margin-left:auto;">Code Editor</span>
  </div>
`;

// ── File Tree ──
async function loadFileTree(path) {
  const tree = document.getElementById('file-tree');
  try {
    let entries;
    if (window.__TAURI__) {
      const { readDir } = await import('@tauri-apps/plugin-fs');
      entries = await readDir(path || '/', { baseDir: 'home' });
    } else {
      // Demo mode — show fake files
      entries = [
        { name: 'src', isDirectory: true },
        { name: 'package.json', isDirectory: false },
        { name: 'Cargo.toml', isDirectory: false },
        { name: 'README.md', isDirectory: false },
      ];
    }
    tree.innerHTML = entries
      .map(e => {
        const icon = e.isDirectory ? '📁' : '📄';
        return `<div style="padding:3px 8px;cursor:pointer;border-radius:3px;font-size:13px;"
          data-path="${path ? path + '/' : ''}${e.name}" data-dir="${e.isDirectory}"
          onmouseover="this.style.background='#2a2d2e'"
          onmouseout="this.style.background='transparent'"
          onclick="handleFileClick(this)">${icon} ${e.name}</div>`;
      })
      .join('');
  } catch (err) {
    tree.innerHTML = `<div style="color:#f48771;font-size:12px;">Cannot read: ${path}</div>`;
  }
}

window.handleFileClick = async function(el) {
  const path = el.dataset.path;
  const isDir = el.dataset.dir === 'true';
  if (isDir) {
    loadFileTree(path);
  } else {
    openFile(path);
  }
};

// ── Editor ──
async function openFile(path) {
  try {
    let content;
    if (window.__TAURI__) {
      const { readTextFile } = await import('@tauri-apps/plugin-fs');
      content = await readTextFile(path, { baseDir: 'home' });
    } else {
      // Demo content
      content = `// ${path}\n// Demo content\nconsole.log('Hello from ${path}');`;
    }
    state.files.set(path, content);
    state.activeFile = path;

    if (state.editor) {
      const ext = path.split('.').pop().toLowerCase();
      const langMap = {
        js: 'javascript', ts: 'typescript', py: 'python',
        go: 'go', rs: 'rust', rb: 'ruby', java: 'java',
        c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
        html: 'html', css: 'css', json: 'json',
        md: 'markdown', sh: 'shell', yaml: 'yaml', yml: 'yaml',
        toml: 'toml', sql: 'sql',
      };
      const lang = langMap[ext] || 'plaintext';
      const model = monaco.editor.createModel(content, lang);
      state.editor.setModel(model);
    }

    updateTabs();
    updateStatus(path);
  } catch (err) {
    document.getElementById('status-left').textContent = `Error: ${err.message}`;
  }
}

// ── Monaco Editor ──
function initEditor() {
  const container = document.getElementById('editor-container');

  state.editor = monaco.editor.create(container, {
    value: '// Welcome to Code Editor for Android\n// Open a file from the sidebar to start coding\n',
    language: 'plaintext',
    theme: 'vs-dark',
    fontSize: 14,
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    tabSize: 2,
    wordWrap: 'on',
    renderWhitespace: 'selection',
  });

  // Save on Ctrl+S
  state.editor.onKeyDown((e) => {
    if ((e.ctrlKey || e.metaKey) && e.keyCode === 83) {
      e.preventDefault();
      saveFile();
    }
  });
}

async function saveFile() {
  if (!state.activeFile) return;
  const content = state.editor.getValue();
  try {
    if (window.__TAURI__) {
      const { writeTextFile } = await import('@tauri-apps/plugin-fs');
      await writeTextFile(state.activeFile, content, { baseDir: 'home' });
    }
    state.files.set(state.activeFile, content);
    document.getElementById('status-left').textContent = `Saved: ${state.activeFile}`;
    setTimeout(() => {
      document.getElementById('status-left').textContent = 'Ready';
    }, 2000);
  } catch (err) {
    document.getElementById('status-left').textContent = `Save error: ${err.message}`;
  }
}

// ── Tabs ──
function updateTabs() {
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = '';
  state.files.forEach((_, path) => {
    const isActive = path === state.activeFile;
    const name = path.split('/').pop();
    const tab = document.createElement('div');
    tab.style.cssText = `
      padding: 6px 12px; font-size: 12px; cursor: pointer;
      background: ${isActive ? '#1e1e1e' : '#2d2d2d'};
      color: ${isActive ? '#e0e0e0' : '#969696'};
      border-right: 1px solid #3c3c3c;
      display: flex; align-items: center; gap: 6px;
      white-space: nowrap;
    `;
    tab.innerHTML = `<span>${name}</span><span style="font-size:14px;margin-left:4px;opacity:0.5;">×</span>`;
    tab.onclick = () => {
      state.activeFile = path;
      const content = state.files.get(path) || '';
      state.editor.setValue(content);
      updateTabs();
      updateStatus(path);
    };
    tabs.appendChild(tab);
  });
}

function updateStatus(path) {
  const name = path ? path.split('/').pop() : 'No file';
  const lang = state.editor?.getModel()?.getLanguageId() || 'plaintext';
  document.getElementById('status-left').textContent = `${name} — ${lang}`;
}

// ── Terminal ──
function initTerminal() {
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'JetBrains Mono, Fira Code, Consolas, monospace',
    theme: {
      background: '#1e1e1e',
      foreground: '#cccccc',
      cursor: '#aeafad',
      selectionBackground: '#264f78',
      black: '#000000',
      red: '#cd3131',
      green: '#0dbc79',
      yellow: '#e5e510',
      blue: '#2472c3',
      magenta: '#bc3fbc',
      cyan: '#11a8cd',
      white: '#e5e5e5',
      brightBlack: '#666666',
      brightRed: '#f14c4c',
      brightGreen: '#23d18b',
      brightYellow: '#f5f543',
      brightBlue: '#3b8eea',
      brightMagenta: '#d670d6',
      brightCyan: '#29b8db',
      brightWhite: '#ffffff',
    },
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());

  const container = document.getElementById('terminal');
  term.open(container);

  // Delay fit to ensure container is rendered
  setTimeout(() => fitAddon.fit(), 100);

  state.terminal = term;

  // Resize handler
  const resizeObserver = new ResizeObserver(() => fitAddon.fit());
  resizeObserver.observe(container);

  // Toggle terminal
  document.getElementById('terminal-close').onclick = () => {
    const tc = document.getElementById('terminal-container');
    tc.style.display = tc.style.display === 'none' ? 'flex' : 'none';
    setTimeout(() => fitAddon.fit(), 50);
  };

  // Send keystrokes to terminal via Rust backend
  term.onData((data) => {
    if (window.__TAURI__) {
      // In Tauri, we'll send to the Rust backend
      import('@tauri-apps/plugin-shell').then(({ invoke }) => {
        invoke('write_terminal', { data }).catch(() => {});
      }).catch(() => {
        // Demo mode — echo back
        term.write(`\r\n[echo] ${data.replace(/\n/g, '')}`);
      });
    } else {
      // Demo mode — echo back
      term.write(`\r\n[echo] ${data.replace(/\n/g, '')}`);
    }
  });

  // Welcome message
  term.writeln('\x1b[32mWelcome to Code Editor Terminal\x1b[0m');
  term.writeln('\x1b[90mType "help" for available commands\x1b[0m');
  term.writeln('');
}

// ── Init ──
async function init() {
  await loadFileTree('');
  initEditor();
  initTerminal();
  document.getElementById('status-left').textContent = 'Code Editor for Android — Ready';
}

init();
