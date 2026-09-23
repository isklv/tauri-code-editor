/**
 * Proxy Manager for Geko.
 *
 * Provides persistent proxy profile storage (localStorage),
 * URL generator (supporting socks5h:// for remote DNS resolution),
 * live connection testing via Rust backend,
 * and dialogs for managing proxies and opening terminal tabs.
 */

import * as api from './api.js';

const STORAGE_KEY = 'geko_proxies';

export function getProxies() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.error('Failed to load proxy profiles:', e);
    return [];
  }
}

export function saveProxy(profile) {
  const proxies = getProxies();
  const idx = proxies.findIndex((p) => p.id === profile.id);
  if (idx >= 0) {
    proxies[idx] = profile;
  } else {
    proxies.push(profile);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(proxies));
  return proxies;
}

export function deleteProxy(id) {
  const proxies = getProxies().filter((p) => p.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(proxies));
  return proxies;
}

export function buildProxyUrl(profile) {
  if (!profile || !profile.host) return null;
  const type = profile.type || 'socks5';
  const proto = type === 'socks5' ? (profile.remoteDns ? 'socks5h://' : 'socks5://') : `${type}://`;
  let auth = '';
  if (profile.username) {
    auth = encodeURIComponent(profile.username);
    if (profile.password) {
      auth += ':' + encodeURIComponent(profile.password);
    }
    auth += '@';
  }
  const port = profile.port ? `:${profile.port}` : '';
  return `${proto}${auth}${profile.host}${port}`;
}

let modalBackdrop = null;

function ensureBackdrop() {
  if (modalBackdrop) return modalBackdrop;
  modalBackdrop = document.createElement('div');
  modalBackdrop.className = 'modal-backdrop';
  modalBackdrop.hidden = true;
  document.body.appendChild(modalBackdrop);
  return modalBackdrop;
}

/**
 * Dialog to open a new terminal tab.
 * Lets the user choose proxy (Default: Direct) and environment (Default: Alpine PRoot).
 */
export function showOpenTerminalTabDialog() {
  return new Promise((resolve) => {
    const backdrop = ensureBackdrop();
    backdrop.textContent = '';
    backdrop.hidden = false;

    const modal = document.createElement('div');
    modal.className = 'modal proxy-launcher-modal';

    const title = document.createElement('div');
    title.className = 'modal-title';
    title.innerHTML = `<span>💻 New Terminal Tab</span>`;
    modal.appendChild(title);

    const form = document.createElement('div');
    form.className = 'proxy-modal-form';

    // Proxy selector group
    const proxyGroup = document.createElement('div');
    proxyGroup.className = 'form-group';
    proxyGroup.innerHTML = `
      <label class="form-label" for="term-proxy-select">Network & Proxy:</label>
    `;
    const proxySelect = document.createElement('select');
    proxySelect.id = 'term-proxy-select';
    proxySelect.className = 'modal-select';

    const directOpt = document.createElement('option');
    directOpt.value = 'direct';
    directOpt.textContent = '🚫 Direct (No proxy)';
    proxySelect.appendChild(directOpt);

    const proxies = getProxies();
    for (const p of proxies) {
      const opt = document.createElement('option');
      opt.value = p.id;
      const url = buildProxyUrl(p);
      opt.textContent = `🛡️ ${p.name} (${p.type.toUpperCase()}: ${p.host}:${p.port})`;
      proxySelect.appendChild(opt);
    }

    proxyGroup.appendChild(proxySelect);
    form.appendChild(proxyGroup);

    // Shell environment selector group
    const envGroup = document.createElement('div');
    envGroup.className = 'form-group';
    envGroup.innerHTML = `
      <label class="form-label" for="term-env-select">Environment:</label>
    `;
    const envSelect = document.createElement('select');
    envSelect.id = 'term-env-select';
    envSelect.className = 'modal-select';

    const alpineOpt = document.createElement('option');
    alpineOpt.value = 'alpine';
    alpineOpt.textContent = '🐧 Alpine Linux (PRoot) — isolated user-space';
    alpineOpt.selected = true; // Default as requested

    const nativeOpt = document.createElement('option');
    nativeOpt.value = 'native';
    nativeOpt.textContent = '📱 Native System Shell';

    envSelect.appendChild(alpineOpt);
    envSelect.appendChild(nativeOpt);
    envGroup.appendChild(envSelect);
    form.appendChild(envGroup);

    // AI Agent Hint / Info box
    const infoBox = document.createElement('div');
    infoBox.className = 'proxy-info-hint';
    infoBox.innerHTML = `
      <div class="hint-title">⚡ Claude Code & Agy Ready</div>
      <div class="hint-text">
        Proxy variables (<code>ALL_PROXY</code>, <code>HTTP_PROXY</code>, <code>HTTPS_PROXY</code>) 
        and full-color PTY are automatically exported for Node.js, Git, and Python.
      </div>
    `;
    form.appendChild(infoBox);

    modal.appendChild(form);

    // Modal actions
    const actions = document.createElement('div');
    actions.className = 'modal-actions space-between';

    const manageBtn = document.createElement('button');
    manageBtn.type = 'button';
    manageBtn.className = 'tool';
    manageBtn.innerHTML = `⚙️ Manage Proxies`;
    manageBtn.addEventListener('click', () => {
      closeDialog(null);
      showProxyManagerModal().then(() => {
        // Re-open launcher dialog after managing proxies
        showOpenTerminalTabDialog().then(resolve);
      });
    });

    const rightActions = document.createElement('div');
    rightActions.className = 'action-buttons-right';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'tool';
    cancelBtn.textContent = 'Cancel';

    const launchBtn = document.createElement('button');
    launchBtn.type = 'button';
    launchBtn.className = 'tool primary';
    launchBtn.textContent = 'Launch Tab';

    rightActions.appendChild(cancelBtn);
    rightActions.appendChild(launchBtn);
    actions.appendChild(manageBtn);
    actions.appendChild(rightActions);
    modal.appendChild(actions);

    backdrop.appendChild(modal);

    function closeDialog(result) {
      backdrop.hidden = true;
      backdrop.textContent = '';
      document.removeEventListener('keydown', onKeyDown, true);
      resolve(result);
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeDialog(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        doLaunch();
      }
    }

    function doLaunch() {
      const selectedProxyId = proxySelect.value;
      const shellMode = envSelect.value;
      let proxyConfig = null;

      if (selectedProxyId !== 'direct') {
        const profile = proxies.find((p) => p.id === selectedProxyId);
        if (profile) {
          const url = buildProxyUrl(profile);
          proxyConfig = {
            profile,
            proxy_url: url,
            name: profile.name,
            type: profile.type,
          };
        }
      }

      closeDialog({
        shellMode,
        proxyConfig,
      });
    }

    cancelBtn.addEventListener('click', () => closeDialog(null));
    launchBtn.addEventListener('click', doLaunch);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeDialog(null);
    });

    document.addEventListener('keydown', onKeyDown, true);
    launchBtn.focus();
  });
}

/**
 * Proxy Manager Modal: add, edit, test, delete proxy profiles.
 */
export function showProxyManagerModal() {
  return new Promise((resolve) => {
    const backdrop = ensureBackdrop();
    backdrop.textContent = '';
    backdrop.hidden = false;

    const modal = document.createElement('div');
    modal.className = 'modal proxy-manager-modal';

    function renderList() {
      modal.textContent = '';

      const title = document.createElement('div');
      title.className = 'modal-title';
      title.innerHTML = `<span>🛡️ Proxy Manager</span>`;
      modal.appendChild(title);

      const desc = document.createElement('div');
      desc.className = 'modal-subtitle';
      desc.textContent = 'Configure SOCKS5 or HTTP proxy profiles for isolated terminal tabs.';
      modal.appendChild(desc);

      const listContainer = document.createElement('div');
      listContainer.className = 'proxy-profiles-list';

      const proxies = getProxies();
      if (proxies.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'proxy-empty-state';
        empty.textContent = 'No proxy profiles added yet. Click "+ Add Proxy" below.';
        listContainer.appendChild(empty);
      } else {
        for (const p of proxies) {
          const item = document.createElement('div');
          item.className = 'proxy-item';

          const info = document.createElement('div');
          info.className = 'proxy-item-info';

          const nameLine = document.createElement('div');
          nameLine.className = 'proxy-item-name';
          nameLine.innerHTML = `<strong>${escapeHtml(p.name)}</strong> <span class="proxy-badge ${p.type}">${p.type.toUpperCase()}${p.remoteDns ? ' (Remote DNS)' : ''}</span>`;

          const detailLine = document.createElement('div');
          detailLine.className = 'proxy-item-detail';
          const authPart = p.username ? `${p.username}@` : '';
          detailLine.textContent = `${authPart}${p.host}:${p.port}`;

          info.appendChild(nameLine);
          info.appendChild(detailLine);
          item.appendChild(info);

          const btns = document.createElement('div');
          btns.className = 'proxy-item-actions';

          const testBtn = document.createElement('button');
          testBtn.className = 'tool small';
          testBtn.textContent = 'Test';
          testBtn.addEventListener('click', async () => {
            testBtn.disabled = true;
            testBtn.textContent = 'Testing...';
            const url = buildProxyUrl(p);
            try {
              const ok = await api.testProxyConnection(url);
              testBtn.textContent = ok ? '✓ Online' : '✗ Failed';
              testBtn.className = ok ? 'tool small success' : 'tool small error';
            } catch (err) {
              testBtn.textContent = '✗ Error';
              testBtn.className = 'tool small error';
              testBtn.title = String(err);
            } finally {
              setTimeout(() => {
                testBtn.disabled = false;
                testBtn.textContent = 'Test';
                testBtn.className = 'tool small';
              }, 3000);
            }
          });

          const editBtn = document.createElement('button');
          editBtn.className = 'tool small';
          editBtn.textContent = 'Edit';
          editBtn.addEventListener('click', () => renderForm(p));

          const delBtn = document.createElement('button');
          delBtn.className = 'tool small danger';
          delBtn.textContent = 'Delete';
          delBtn.addEventListener('click', () => {
            if (confirm(`Delete proxy "${p.name}"?`)) {
              deleteProxy(p.id);
              renderList();
            }
          });

          btns.appendChild(testBtn);
          btns.appendChild(editBtn);
          btns.appendChild(delBtn);
          item.appendChild(btns);

          listContainer.appendChild(item);
        }
      }

      modal.appendChild(listContainer);

      const actions = document.createElement('div');
      actions.className = 'modal-actions space-between';

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'tool primary';
      addBtn.textContent = '+ Add Proxy';
      addBtn.addEventListener('click', () => renderForm(null));

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'tool';
      closeBtn.textContent = 'Done';
      closeBtn.addEventListener('click', () => closeManager());

      actions.appendChild(addBtn);
      actions.appendChild(closeBtn);
      modal.appendChild(actions);
    }

    function renderForm(existing) {
      modal.textContent = '';

      const title = document.createElement('div');
      title.className = 'modal-title';
      title.textContent = existing ? `Edit Proxy: ${existing.name}` : 'Add New Proxy';
      modal.appendChild(title);

      const form = document.createElement('div');
      form.className = 'proxy-edit-form';

      form.innerHTML = `
        <div class="form-group">
          <label class="form-label" for="pf-name">Profile Name:</label>
          <input type="text" id="pf-name" class="modal-input" placeholder="e.g. Local SOCKS5 / Tor" value="${escapeHtml(existing?.name || '')}" />
        </div>
        <div class="form-row">
          <div class="form-group col-4">
            <label class="form-label" for="pf-type">Protocol:</label>
            <select id="pf-type" class="modal-select">
              <option value="socks5" ${existing?.type === 'socks5' || !existing ? 'selected' : ''}>SOCKS5</option>
              <option value="http" ${existing?.type === 'http' ? 'selected' : ''}>HTTP</option>
              <option value="https" ${existing?.type === 'https' ? 'selected' : ''}>HTTPS</option>
            </select>
          </div>
          <div class="form-group col-5">
            <label class="form-label" for="pf-host">Host / IP:</label>
            <input type="text" id="pf-host" class="modal-input" placeholder="127.0.0.1" value="${escapeHtml(existing?.host || '')}" />
          </div>
          <div class="form-group col-3">
            <label class="form-label" for="pf-port">Port:</label>
            <input type="number" id="pf-port" class="modal-input" placeholder="1080" value="${existing?.port || 1080}" />
          </div>
        </div>
        <div class="form-group checkbox-group" id="pf-dns-row">
          <label class="checkbox-label">
            <input type="checkbox" id="pf-dns" ${existing?.remoteDns !== false ? 'checked' : ''} />
            <span>Remote DNS resolution (socks5h://) — prevents DNS leaks and blocks</span>
          </label>
        </div>
        <div class="form-row">
          <div class="form-group col-6">
            <label class="form-label" for="pf-user">Username (optional):</label>
            <input type="text" id="pf-user" class="modal-input" placeholder="Username" value="${escapeHtml(existing?.username || '')}" />
          </div>
          <div class="form-group col-6">
            <label class="form-label" for="pf-pass">Password (optional):</label>
            <input type="password" id="pf-pass" class="modal-input" placeholder="Password" value="${escapeHtml(existing?.password || '')}" />
          </div>
        </div>
        <div class="form-feedback" id="pf-feedback" style="display:none;"></div>
      `;

      modal.appendChild(form);

      const typeSelect = form.querySelector('#pf-type');
      const dnsRow = form.querySelector('#pf-dns-row');
      typeSelect.addEventListener('change', () => {
        dnsRow.style.display = typeSelect.value === 'socks5' ? 'block' : 'none';
      });
      dnsRow.style.display = typeSelect.value === 'socks5' ? 'block' : 'none';

      const actions = document.createElement('div');
      actions.className = 'modal-actions space-between';

      const testBtn = document.createElement('button');
      testBtn.type = 'button';
      testBtn.className = 'tool';
      testBtn.textContent = 'Test Connection';

      const rightActions = document.createElement('div');
      rightActions.className = 'action-buttons-right';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'tool';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => renderList());

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'tool primary';
      saveBtn.textContent = 'Save';

      rightActions.appendChild(cancelBtn);
      rightActions.appendChild(saveBtn);
      actions.appendChild(testBtn);
      actions.appendChild(rightActions);
      modal.appendChild(actions);

      const feedback = form.querySelector('#pf-feedback');

      function collectProfile() {
        const name = form.querySelector('#pf-name').value.trim();
        const type = form.querySelector('#pf-type').value;
        const host = form.querySelector('#pf-host').value.trim();
        const portStr = form.querySelector('#pf-port').value.trim();
        const port = parseInt(portStr, 10);
        const remoteDns = form.querySelector('#pf-dns').checked;
        const username = form.querySelector('#pf-user').value.trim();
        const password = form.querySelector('#pf-pass').value.trim();

        if (!name) {
          showFeedback('Profile name is required.', 'error');
          return null;
        }
        if (!host) {
          showFeedback('Host is required.', 'error');
          return null;
        }
        if (isNaN(port) || port <= 0 || port > 65535) {
          showFeedback('Port must be between 1 and 65535.', 'error');
          return null;
        }

        return {
          id: existing?.id || `proxy_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name,
          type,
          host,
          port,
          remoteDns: type === 'socks5' ? remoteDns : false,
          username,
          password,
        };
      }

      function showFeedback(msg, kind) {
        feedback.textContent = msg;
        feedback.className = `form-feedback ${kind}`;
        feedback.style.display = 'block';
      }

      testBtn.addEventListener('click', async () => {
        const p = collectProfile();
        if (!p) return;
        testBtn.disabled = true;
        testBtn.textContent = 'Testing...';
        showFeedback('Connecting to proxy...', 'info');
        const url = buildProxyUrl(p);
        try {
          const ok = await api.testProxyConnection(url);
          if (ok) {
            showFeedback(`✓ Successfully connected to ${p.host}:${p.port}`, 'success');
          } else {
            showFeedback(`✗ Could not connect to ${p.host}:${p.port}`, 'error');
          }
        } catch (e) {
          showFeedback(`✗ Connection failed: ${e}`, 'error');
        } finally {
          testBtn.disabled = false;
          testBtn.textContent = 'Test Connection';
        }
      });

      saveBtn.addEventListener('click', () => {
        const p = collectProfile();
        if (!p) return;
        saveProxy(p);
        renderList();
      });
    }

    function closeManager() {
      backdrop.hidden = true;
      backdrop.textContent = '';
      resolve();
    }

    renderList();
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
