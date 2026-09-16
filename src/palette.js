/**
 * Quick-open palette (Ctrl+P).
 *
 * Keyboard-first file switching — the fastest way to move around a project on
 * Samsung DeX or any desktop, where a real keyboard is available.
 */

import { basename, findFiles } from './api.js';

let host = null;

/** Dismisses the palette that is currently open, if any. */
let dismissOpen = null;

function ensureHost() {
  if (host) return host;
  host = document.createElement('div');
  host.className = 'modal-backdrop palette-backdrop';
  host.hidden = true;
  // Bound once: re-binding per open would leave one listener per palette ever
  // shown, each closing over a palette that is long gone.
  host.addEventListener('click', (e) => {
    if (e.target === host) dismissOpen?.();
  });
  document.body.appendChild(host);
  return host;
}

/**
 * @param {string} root folder to search
 * @returns {Promise<string|null>} chosen file path, or null when dismissed
 */
export function openPalette(root) {
  const backdrop = ensureHost();
  backdrop.textContent = '';
  backdrop.hidden = false;

  const box = document.createElement('div');
  box.className = 'modal palette';

  const input = document.createElement('input');
  input.className = 'modal-input';
  input.placeholder = 'Go to file…';
  input.spellcheck = false;
  // Soft keyboards otherwise autocorrect and capitalize file names, and draw
  // their composing text over what is already in the field.
  input.autocomplete = 'off';
  input.autocapitalize = 'off';
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('enterkeyhint', 'go');
  box.appendChild(input);

  const list = document.createElement('div');
  list.className = 'palette-list';
  box.appendChild(list);

  backdrop.appendChild(box);

  let items = [];
  let selected = 0;
  let searchToken = 0;

  const paint = () => {
    list.textContent = '';
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'palette-empty';
      empty.textContent = 'No matching files';
      list.appendChild(empty);
      return;
    }
    items.forEach((path, index) => {
      const row = document.createElement('div');
      row.className = index === selected ? 'palette-item selected' : 'palette-item';

      const name = document.createElement('span');
      name.className = 'palette-name';
      name.textContent = basename(path);

      const dir = document.createElement('span');
      dir.className = 'palette-dir';
      dir.textContent = path.startsWith(root) ? path.slice(root.length + 1) : path;

      row.append(name, dir);
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        finish(path);
      });
      list.appendChild(row);
    });
    list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  };

  const search = async () => {
    const token = ++searchToken;
    let found = [];
    try {
      found = await findFiles(root, input.value.trim());
    } catch {
      found = []; // an unreadable root simply yields no matches
    }
    if (token !== searchToken) return; // a newer keystroke already won
    items = found.slice(0, 100);
    selected = 0;
    paint();
  };

  let resolveChoice;
  const finish = (value) => {
    backdrop.hidden = true;
    backdrop.textContent = '';
    document.removeEventListener('keydown', onKey, true);
    if (dismissOpen === cancel) dismissOpen = null;
    resolveChoice(value);
  };
  const cancel = () => finish(null);

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    } else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      e.stopPropagation();
      selected = Math.min(selected + 1, items.length - 1);
      paint();
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      e.stopPropagation();
      selected = Math.max(selected - 1, 0);
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      finish(items[selected] ?? null);
    }
  };

  document.addEventListener('keydown', onKey, true);
  input.addEventListener('input', search);
  dismissOpen = cancel;
  input.focus();
  search();

  return new Promise((resolve) => {
    resolveChoice = resolve;
  });
}
