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


const HELPER_KEYS = [
  ['Esc', '\x1b'],
  ['Tab', '\t'],
  ['Ctrl', null], // sticky modifier, applied to the next character
  ['←', '\x1b[D'],
  ['↓', '\x1b[B'],
  ['↑', '\x1b[A'],
  ['→', '\x1b[C'],
  ['^C', '\x03'],
  ['/', '/'],
  ['-', '-'],
  ['_', '_'],
  ['~', '~'],
  ['|', '|'],
  [':', ':'],
  ['$', '$'],
  ['&', '&'],
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
    this.setupAndroidInputFix();

    this.term.onData((data) => this.send(data));

    if (keyBar) this.buildKeyBar(keyBar);

    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(host);

    this.sessionId = null;
    this.starting = false;
    this.restartListener = null;
    this.proxy = null;
    this.unsubs = [];

    onPtyOutput((bytes, id) => {
      if (id && this.sessionId && id !== this.sessionId) {
        return;
      }
      this.term.write(bytes);
    }).then((unsub) => this.unsubs.push(unsub));

    onPtyExit((exitId) => {
      // Ignore exit event if a new session is currently starting or belongs to an old session
      if (this.starting) {
        return;
      }
      if (exitId && this.sessionId && exitId !== this.sessionId) {
        return;
      }
      this.running = false;
      this.term.writeln('\r\n\x1b[90m[shell exited — press Enter to restart]\x1b[0m');
      if (this.restartListener) {
        this.restartListener.dispose();
      }
      this.restartListener = this.term.onData(() => {
        if (this.restartListener) {
          this.restartListener.dispose();
          this.restartListener = null;
        }
        this.start(this.cwd, this.shellMode, this.proxy);
      });
    }).then((unsub) => this.unsubs.push(unsub));
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
    if (this.running) ptyWrite(data, this.sessionId).catch((e) => this.writeError(e));
    else this.term.write(data.replace(/\r/g, '\r\n')); // local echo with no shell attached
  }

  buildKeyBar(bar) {
    this.keyBar = bar;
    for (const [label, sequence] of HELPER_KEYS) {
      const key = document.createElement('button');
      key.className = 'term-key';
      key.textContent = label;
      key.setAttribute('type', 'button');
      key.setAttribute('tabindex', '-1');
      key.addEventListener('pointerdown', (e) => {
        // Prevent button from stealing focus from xterm textarea on mobile/touch
        e.preventDefault();
      });
      key.addEventListener('click', (e) => {
        e.preventDefault();
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

  setupAndroidInputFix() {
    const textarea = this.term.textarea;
    if (!textarea) return;

    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('autocapitalize', 'none');
    textarea.setAttribute('spellcheck', 'false');
    textarea.setAttribute('enterkeyhint', 'enter');

    const isAndroid = /Android/i.test(navigator.userAgent);
    if (!isAndroid) return;

    // On Android, soft keyboards (like Gboard) initiate IME composition sessions
    // for all words by default. In xterm, CompositionHelper intercepts composition events,
    // which displays an overlay and withholds characters from the shell until space or enter.
    // That causes the cursor to freeze blinking at the beginning of the word.
    //
    // By intercepting and stopping composition events in the capture phase,
    // xterm's internal _isComposing flag remains false. When _isComposing is false,
    // xterm's built-in _handleAnyTextareaChanges() automatically handles keyCode 229
    // by diffing the textarea value and forwarding each character immediately to
    // onData, which moves the cursor in real time without duplicating characters.
    textarea.addEventListener(
      'compositionstart',
      (e) => {
        e.stopImmediatePropagation();
      },
      true,
    );

    textarea.addEventListener(
      'compositionupdate',
      (e) => {
        e.stopImmediatePropagation();
      },
      true,
    );

    textarea.addEventListener(
      'compositionend',
      (e) => {
        e.stopImmediatePropagation();
      },
      true,
    );

    textarea.addEventListener('focus', () => {
      // Ensure terminal fits and scrolls to cursor when keyboard pops up
      setTimeout(() => {
        this.fit();
        this.term.scrollToBottom();
      }, 100);
      setTimeout(() => {
        this.fit();
        this.term.scrollToBottom();
      }, 350);
    });
  }

  fit() {
    if (this.host.clientHeight < 10 || this.host.clientWidth < 10) return;
    try {
      this.fitAddon.fit();
    } catch {
      return; // xterm throws while the panel is mid-animation; the next observation retries
    }
    if (this.running) ptyResize(this.term.cols, this.term.rows, this.sessionId).catch(() => {});
  }

  /** Spawn (or respawn) the shell. Safe to call repeatedly. */
  async start(cwd, shellMode, proxy = null) {
    if (this.restartListener) {
      this.restartListener.dispose();
      this.restartListener = null;
    }
    this.starting = true;
    this.cwd = cwd ?? this.cwd;
    if (shellMode !== undefined) this.shellMode = shellMode;
    if (proxy !== undefined) this.proxy = proxy;
    if (!isTauri) {
      this.term.writeln('\x1b[33mTerminal requires the desktop app (npm run tauri:dev).\x1b[0m');
      this.starting = false;
      return false;
    }
    this.fit();
    try {
      this.sessionId = await ptyStart(
        this.cwd,
        this.term.cols,
        this.term.rows,
        this.shellMode ?? null,
        this.proxy ?? null,
      );
      this.running = true;
      return true;
    } catch (e) {
      this.writeError(e);
      return false;
    } finally {
      this.starting = false;
    }
  }

  /**
   * Navigate the terminal to cwd. If a shell is currently running, sends a cd
   * command so existing processes and exported environment variables are preserved.
   * If no shell is running, starts one.
   */
  async setCwd(cwd) {
    this.cwd = cwd ?? this.cwd;
    if (this.running) {
      let target = cwd;
      if (target.includes('/alpine/root')) {
        const sub = target.split('/alpine/root')[1] || '';
        target = '/root' + sub;
      }
      await ptyWrite(` cd ${JSON.stringify(target)}\n`, this.sessionId).catch(() => {});
    } else {
      await this.start(cwd, this.shellMode, this.proxy);
    }
  }

  /** Returns whether a shell is attached, so callers can fall back to another one. */
  async restart(cwd, shellMode, proxy) {
    this.term.reset();
    this.running = false;
    return this.start(cwd, shellMode, proxy ?? this.proxy);
  }

  async dispose() {
    this.resizeObserver?.disconnect();
    for (const unsub of this.unsubs) {
      try {
        unsub();
      } catch {}
    }
    this.unsubs = [];
    if (this.restartListener) {
      this.restartListener.dispose();
      this.restartListener = null;
    }
    if (this.sessionId) {
      await ptyKill(this.sessionId).catch(() => {});
    }
    this.term.dispose();
  }

  focus() {
    this.term.focus();
  }

  writeError(e) {
    this.term.writeln(`\r\n\x1b[31m${String(e)}\x1b[0m`);
  }
}
