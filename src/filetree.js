/** Expandable file explorer backed by the `list_dir` command. */

import { listDir } from './api.js';
import { getFileIconHtml } from './icons.js';

export class FileTree {
  /**
   * @param {HTMLElement} host container element
   * @param {{
   *   onOpenFile: (path: string) => void,
   *   onError: (message: string) => void,
   *   onContextMenu?: (entry: object, x: number, y: number) => void,
   * }} handlers
   */
  constructor(host, handlers) {
    this.host = host;
    this.handlers = handlers;
    this.root = null;
    this.expanded = new Set();
    this.children = new Map(); // path -> entries
    this.activePath = null;
    this.refreshing = false;
    this.pendingRefresh = false;
  }

  /** Point the explorer at `path`. Throws if the folder cannot be read. */
  async setRoot(path) {
    const listing = await listDir(path);
    this.root = path;
    this.expanded = new Set([path]);
    this.children = new Map([[path, listing.entries]]);
    this.activePath = null;
    this.render();
  }

  /** Re-read every expanded directory and repaint only if entries changed. */
  async refresh() {
    if (!this.root) return;
    if (this.refreshing) {
      this.pendingRefresh = true;
      return;
    }
    this.refreshing = true;
    try {
      const results = await Promise.all(
        [...this.expanded].map(async (dir) => {
          try {
            return [dir, (await listDir(dir)).entries];
          } catch {
            return [dir, null]; // directory vanished or is unreadable
          }
        }),
      );
      let changed = false;
      for (const [dir, entries] of results) {
        const current = this.children.get(dir);
        if (!entries) {
          if (this.children.has(dir)) {
            this.children.delete(dir);
            this.expanded.delete(dir);
            changed = true;
          }
        } else if (!current || !areEntriesEqual(current, entries)) {
          this.children.set(dir, entries);
          changed = true;
        }
      }
      if (changed) {
        this.render();
      }
    } finally {
      this.refreshing = false;
      if (this.pendingRefresh) {
        this.pendingRefresh = false;
        this.refresh();
      }
    }
  }

  async toggle(path) {
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
      this.render();
      return;
    }
    this.expanded.add(path);
    if (!this.children.has(path)) {
      try {
        this.children.set(path, (await listDir(path)).entries);
      } catch (e) {
        this.expanded.delete(path);
        this.handlers.onError(String(e));
      }
    }
    this.render();
  }

  setActive(path) {
    this.activePath = path;
    for (const row of this.host.querySelectorAll('.tree-row')) {
      row.classList.toggle('active', row.getAttribute('data-path') === path);
    }
  }

  render() {
    const prevScroll = this.host.scrollTop;
    this.host.textContent = '';
    if (!this.root) {
      this.host.appendChild(message('No folder opened'));
      return;
    }
    const entries = this.children.get(this.root);
    if (!entries) {
      this.host.appendChild(message(`Cannot read ${this.root}`, true));
      return;
    }
    if (entries.length === 0) {
      this.host.appendChild(message('Folder is empty'));
      return;
    }
    this.renderLevel(entries, 0, this.host);
    this.host.scrollTop = prevScroll;
  }

  renderLevel(entries, depth, parentEl) {
    for (const entry of entries) {
      parentEl.appendChild(this.renderRow(entry, depth));
      if (entry.is_dir && this.expanded.has(entry.path)) {
        const children = this.children.get(entry.path);
        if (children?.length) this.renderLevel(children, depth + 1, parentEl);
      }
    }
  }

  renderRow(entry, depth) {
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.setAttribute('data-path', entry.path);
    if (entry.path === this.activePath) row.classList.add('active');
    row.style.paddingLeft = `${8 + depth * 12}px`;
    row.title = entry.path;

    const twisty = document.createElement('span');
    twisty.className = 'twisty';
    twisty.textContent = entry.is_dir ? (this.expanded.has(entry.path) ? '▾' : '▸') : '';
    row.appendChild(twisty);

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.innerHTML = getFileIconHtml(entry.name, entry.is_dir, this.expanded.has(entry.path));
    row.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = entry.name; // textContent, so odd file names cannot inject markup
    row.appendChild(label);

    const openMenu = (x, y) => this.handlers.onContextMenu?.(entry, x, y);
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY);
    });

    // Touch tap and long-press handling
    let pressTimer = null;
    let startX = 0;
    let startY = 0;
    let isTouchMove = false;
    let longPressed = false;
    let lastTouchOpenTime = 0;

    const cancelPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };

    row.addEventListener('touchstart', (e) => {
      if (e.touches.length > 1) {
        cancelPress();
        return;
      }
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      isTouchMove = false;
      longPressed = false;
      pressTimer = setTimeout(() => {
        longPressed = true;
        openMenu(touch.clientX, touch.clientY);
      }, 500);
    }, { passive: true });

    row.addEventListener('touchmove', (e) => {
      if (isTouchMove) return;
      const touch = e.touches[0];
      if (Math.hypot(touch.clientX - startX, touch.clientY - startY) > 10) {
        isTouchMove = true;
        cancelPress();
      }
    }, { passive: true });

    row.addEventListener('touchend', () => {
      cancelPress();
      if (!longPressed && !isTouchMove) {
        lastTouchOpenTime = Date.now();
        if (entry.is_dir) this.toggle(entry.path);
        else this.handlers.onOpenFile(entry.path);
      }
    }, { passive: true });

    row.addEventListener('touchcancel', cancelPress, { passive: true });

    row.addEventListener('click', () => {
      if (Date.now() - lastTouchOpenTime < 400) return;
      if (entry.is_dir) this.toggle(entry.path);
      else this.handlers.onOpenFile(entry.path);
    });

    return row;
  }
}

function areEntriesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].path !== b[i].path || a[i].name !== b[i].name || a[i].is_dir !== b[i].is_dir || a[i].size !== b[i].size) {
      return false;
    }
  }
  return true;
}

function message(text, isError = false) {
  const el = document.createElement('div');
  el.className = isError ? 'tree-message error' : 'tree-message';
  el.textContent = text;
  return el;
}
