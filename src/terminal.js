/** xterm.js front-end wired to the Rust PTY. */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

import { isTauri, onPtyExit, onPtyOutput, ptyKill, ptyResize, ptyStart, ptyWrite } from './api.js';

const THEME = {
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
};

/** Sequences for the on-screen helper keys. */
const HELPER_KEYS = [
  ['Esc', '\x1b'],
  ['Tab', '\t'],
  ['Ctrl', null], // sticky modifier, applied to the next character
  ['←', '\x1b[D'],
  ['↓', '\x1b[B'],
  ['↑', '\x1b[A'],
  ['→', '\x1b[C'],
  ['^C', '\x03'],
  ['|', '|'],
  ['~', '~'],
  ['/', '/'],
  ['-', '-'],
];

export class TerminalPanel {
  constructor(host, keyBar) {
    this.host = host;
    this.running = false;
    this.cwd = null;
    this.ctrlSticky = false;

    this.term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono-font').trim(),
      scrollback: 5000,
      allowProposedApi: true,
      theme: THEME,
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new WebLinksAddon());
    this.term.open(host);

    this.term.onData((data) => this.send(data));

    if (keyBar) this.buildKeyBar(keyBar);

    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(host);

    onPtyOutput((bytes) => this.term.write(bytes));
    onPtyExit(() => {
      this.running = false;
      this.term.writeln('\r\n\x1b[90m[shell exited — press Enter to restart]\x1b[0m');
      const once = this.term.onData(() => {
        once.dispose();
        this.start(this.cwd);
      });
    });
  }

  /** Send input to the shell, applying a pending Ctrl from the helper bar. */
  send(data) {
    if (this.ctrlSticky) {
      this.ctrlSticky = false;
      this.keyBar?.querySelector('.term-key.sticky')?.classList.remove('sticky');
      if (data.length === 1) {
        const code = data.toUpperCase().charCodeAt(0);
        // Ctrl maps A-Z and a few punctuation keys onto codes 0x00-0x1f.
        if (code >= 64 && code < 96) data = String.fromCharCode(code & 0x1f);
      }
    }
    if (this.running) ptyWrite(data).catch((e) => this.writeError(e));
    else this.term.write(data.replace(/\r/g, '\r\n')); // local echo with no shell attached
  }

  buildKeyBar(bar) {
    this.keyBar = bar;
    for (const [label, sequence] of HELPER_KEYS) {
      const key = document.createElement('button');
      key.className = 'term-key';
      key.textContent = label;
      key.addEventListener('click', () => {
        if (sequence === null) {
          this.ctrlSticky = !this.ctrlSticky;
          key.classList.toggle('sticky', this.ctrlSticky);
        } else {
          this.send(sequence);
        }
        this.term.focus();
      });
      bar.appendChild(key);
    }
  }

  fit() {
    if (this.host.clientHeight < 10 || this.host.clientWidth < 10) return;
    try {
      this.fitAddon.fit();
    } catch {
      return; // xterm throws while the panel is mid-animation; the next observation retries
    }
    if (this.running) ptyResize(this.term.cols, this.term.rows).catch(() => {});
  }

  /** Spawn (or respawn) the shell. Safe to call repeatedly. */
  async start(cwd, shellMode) {
    this.cwd = cwd ?? this.cwd;
    if (shellMode !== undefined) this.shellMode = shellMode;
    if (!isTauri) {
      this.term.writeln('\x1b[33mTerminal requires the desktop app (npm run tauri:dev).\x1b[0m');
      return;
    }
    this.fit();
    try {
      await ptyStart(this.cwd, this.term.cols, this.term.rows, this.shellMode ?? null);
      this.running = true;
    } catch (e) {
      this.writeError(e);
    }
  }

  async restart(cwd, shellMode) {
    this.term.reset();
    this.running = false;
    await this.start(cwd, shellMode);
  }

  async dispose() {
    this.resizeObserver.disconnect();
    await ptyKill().catch(() => {});
    this.term.dispose();
  }

  focus() {
    this.term.focus();
  }

  writeError(e) {
    this.term.writeln(`\r\n\x1b[31m${String(e)}\x1b[0m`);
  }
}
