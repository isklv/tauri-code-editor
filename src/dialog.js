/**
 * In-app modal dialogs.
 *
 * `window.prompt`/`window.confirm` are unreliable inside webviews (WebKitGTK and
 * Android WKWebView may suppress them entirely), so the editor ships its own.
 */

let host = null;

function ensureHost() {
  if (host) return host;
  host = document.createElement('div');
  host.className = 'modal-backdrop';
  host.hidden = true;
  document.body.appendChild(host);
  return host;
}

function open({ title, initial, confirmLabel, withInput }) {
  const backdrop = ensureHost();
  backdrop.textContent = '';
  backdrop.hidden = false;

  const box = document.createElement('div');
  box.className = 'modal';

  const heading = document.createElement('div');
  heading.className = 'modal-title';
  heading.textContent = title;
  box.appendChild(heading);

  let input = null;
  if (withInput) {
    input = document.createElement('input');
    input.className = 'modal-input';
    input.value = initial ?? '';
    input.spellcheck = false;
    box.appendChild(input);
  }

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.className = 'tool';
  cancel.textContent = 'Cancel';
  const ok = document.createElement('button');
  ok.className = 'tool primary';
  ok.textContent = confirmLabel ?? 'OK';
  actions.append(cancel, ok);
  box.appendChild(actions);
  backdrop.appendChild(box);

  return new Promise((resolve) => {
    const finish = (value) => {
      backdrop.hidden = true;
      backdrop.textContent = '';
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish(withInput ? input.value.trim() || null : true);
      }
    };
    document.addEventListener('keydown', onKey, true);
    cancel.addEventListener('click', () => finish(null));
    ok.addEventListener('click', () => finish(withInput ? input.value.trim() || null : true));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(null);
    });
    (input ?? ok).focus();
    input?.select();
  });
}

/** Ask for a line of text. Resolves to the trimmed string, or null if cancelled. */
export function askText(title, initial = '') {
  return open({ title, initial, withInput: true, confirmLabel: 'Create' });
}

/** Ask for confirmation. Resolves to true, or null if cancelled. */
export function askConfirm(title, confirmLabel = 'Yes') {
  return open({ title, withInput: false, confirmLabel });
}

/**
 * Folder chooser used where the system picker is unusable (Android returns
 * `content://` URIs). Offers the named roots plus a free-form path.
 */
export function askFolder(roots, initial = '') {
  const backdrop = ensureHost();
  backdrop.textContent = '';
  backdrop.hidden = false;

  const box = document.createElement('div');
  box.className = 'modal';

  const heading = document.createElement('div');
  heading.className = 'modal-title';
  heading.textContent = 'Open folder';
  box.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'modal-list';
  box.appendChild(list);

  const input = document.createElement('input');
  input.className = 'modal-input';
  input.value = initial;
  input.spellcheck = false;
  input.placeholder = '/path/to/folder';
  box.appendChild(input);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.className = 'tool';
  cancel.textContent = 'Cancel';
  const ok = document.createElement('button');
  ok.className = 'tool primary';
  ok.textContent = 'Open';
  actions.append(cancel, ok);
  box.appendChild(actions);
  backdrop.appendChild(box);

  return new Promise((resolve) => {
    const finish = (value) => {
      backdrop.hidden = true;
      backdrop.textContent = '';
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish(input.value.trim() || null);
      }
    };
    document.addEventListener('keydown', onKey, true);

    for (const root of roots) {
      const row = document.createElement('button');
      row.className = 'modal-list-item';
      const name = document.createElement('span');
      name.textContent = root.name;
      const path = document.createElement('span');
      path.className = 'modal-list-path';
      path.textContent = root.path.includes('/alpine/root') ? '/root' : root.path;
      row.append(name, path);
      row.addEventListener('click', () => finish(root.path));
      list.appendChild(row);
    }

    cancel.addEventListener('click', () => finish(null));
    ok.addEventListener('click', () => finish(input.value.trim() || null));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(null);
    });
    input.focus();
    input.select();
  });
}

/** Show an informative modal dialog with a Close button. */
export function showInfo(title, message) {
  const backdrop = ensureHost();
  backdrop.textContent = '';
  backdrop.hidden = false;

  const box = document.createElement('div');
  box.className = 'modal';

  const heading = document.createElement('div');
  heading.className = 'modal-title';
  heading.textContent = title;
  box.appendChild(heading);

  const body = document.createElement('div');
  body.className = 'modal-body';
  body.style.whiteSpace = 'pre-wrap';
  body.style.fontSize = '13px';
  body.style.lineHeight = '1.6';
  body.style.color = 'var(--fg-dim, #ccc)';
  body.style.margin = '12px 0 20px 0';
  body.textContent = message;
  box.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const ok = document.createElement('button');
  ok.className = 'tool primary';
  ok.textContent = 'Close';
  actions.appendChild(ok);
  box.appendChild(actions);

  backdrop.appendChild(box);

  return new Promise((resolve) => {
    const finish = () => {
      backdrop.hidden = true;
      backdrop.textContent = '';
      document.removeEventListener('keydown', onKey, true);
      resolve();
    };
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish();
      }
    };
    document.addEventListener('keydown', onKey, true);
    ok.addEventListener('click', finish);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish();
    });
    ok.focus();
  });
}
