/**
 * Right-click menu for the file explorer.
 *
 * Under Samsung DeX the editor is driven with a mouse, so file operations
 * belong on a context menu rather than behind toolbar buttons only. Touch
 * devices reach the same menu with a long press.
 */

let menu = null;

function ensureMenu() {
  if (menu) return menu;
  menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.hidden = true;
  document.body.appendChild(menu);
  document.addEventListener('mousedown', (e) => {
    if (!menu.contains(e.target)) hideMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideMenu();
  });
  window.addEventListener('resize', hideMenu);
  return menu;
}

export function hideMenu() {
  if (menu) menu.hidden = true;
}

/**
 * @param {number} x viewport coordinates of the click
 * @param {number} y
 * @param {{label: string, action: () => void, danger?: boolean}[]} items
 */
export function showMenu(x, y, items) {
  const el = ensureMenu();
  el.textContent = '';
  for (const item of items) {
    if (item.separator) {
      const hr = document.createElement('div');
      hr.className = 'context-separator';
      el.appendChild(hr);
      continue;
    }
    const button = document.createElement('button');
    button.className = item.danger ? 'context-item danger' : 'context-item';
    button.textContent = item.label;
    button.addEventListener('click', () => {
      hideMenu();
      item.action();
    });
    el.appendChild(button);
  }

  // Place it on screen first, then nudge it back inside the viewport.
  el.hidden = false;
  el.style.left = '0px';
  el.style.top = '0px';
  const rect = el.getBoundingClientRect();
  el.style.left = `${Math.min(x, window.innerWidth - rect.width - 4)}px`;
  el.style.top = `${Math.min(y, window.innerHeight - rect.height - 4)}px`;
}
