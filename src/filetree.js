/** Expandable file explorer backed by the `list_dir` command. */

import { listDir } from './api.js';

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

  /** Re-read every expanded directory and repaint. */
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
      for (const [dir, entries] of results) {
        if (entries) this.children.set(dir, entries);
        else {
          this.children.delete(dir);
          this.expanded.delete(dir);
        }
      }
      this.render();
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
    this.render();
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
    if (entry.path === this.activePath) row.classList.add('active');
    row.style.paddingLeft = `${8 + depth * 12}px`;
    row.title = entry.path;

    const twisty = document.createElement('span');
    twisty.className = 'twisty';
    twisty.textContent = entry.is_dir ? (this.expanded.has(entry.path) ? '▾' : '▸') : '';
    row.appendChild(twisty);

    const icon = document.createElement('span');
    icon.textContent = entry.is_dir ? '📁' : '📄';
    row.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = entry.name; // textContent, so odd file names cannot inject markup
    row.appendChild(label);

    row.addEventListener('click', () => {
      if (entry.is_dir) this.toggle(entry.path);
      else this.handlers.onOpenFile(entry.path);
    });

    const openMenu = (x, y) => this.handlers.onContextMenu?.(entry, x, y);
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY);
    });

    // Long press is the touch equivalent of a right click.
    let pressTimer = null;
    const cancelPress = () => clearTimeout(pressTimer);
    row.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      pressTimer = setTimeout(() => openMenu(touch.clientX, touch.clientY), 550);
    }, { passive: true });
    for (const event of ['touchend', 'touchmove', 'touchcancel']) {
      row.addEventListener(event, cancelPress, { passive: true });
    }

    return row;
  }
}

function message(text, isError = false) {
  const el = document.createElement('div');
  el.className = isError ? 'tree-message error' : 'tree-message';
  el.textContent = text;
  return el;
}
