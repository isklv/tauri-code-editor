/**
 * Source Control and GitHub integration panel.
 */

import * as api from './api.js';
import { getFileIconHtml, SVG_ICONS } from './icons.js';
import { askConfirm, askText } from './dialog.js';

export class GitPanel {
  /**
   * @param {HTMLElement} host
   * @param {{
   *   getRoot: () => string | null,
   *   onOpenFile: (path: string) => void,
   *   onOpenDiff: (file: { path: string, full_path: string, staged: boolean }) => void,
   *   onFolderChanged: (newRoot: string) => void,
   *   onError: (msg: string) => void,
   *   onStatusUpdated?: (status: any) => void,
   * }} handlers
   */
  constructor(host, handlers) {
    this.host = host;
    this.handlers = handlers;
    this.status = null;
    this.loading = false;
    this.githubUser = null;
    this.commitMsg = '';

    this.checkStoredGitHubUser();
  }

  get token() {
    return localStorage.getItem('github_token') || null;
  }

  set token(val) {
    if (val) localStorage.setItem('github_token', val);
    else localStorage.removeItem('github_token');
  }

  async checkStoredGitHubUser() {
    if (this.token) {
      try {
        this.githubUser = await api.githubGetUser(this.token);
      } catch {
        this.githubUser = null;
      }
    }
  }

  async refresh() {
    const root = this.handlers.getRoot();
    if (!root) {
      this.status = null;
      this.render();
      return;
    }

    this.loading = true;
    try {
      this.status = await api.gitStatus(root);
      if (this.handlers.onStatusUpdated) {
        this.handlers.onStatusUpdated(this.status);
      }
    } catch (e) {
      console.warn('Git status error:', e);
      this.status = null;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  async commit() {
    const root = this.handlers.getRoot();
    if (!root || !this.status?.is_repo) return;

    const msg = this.commitMsg.trim();
    if (!msg) {
      this.handlers.onError('Please enter a commit message');
      return;
    }

    try {
      // If no staged changes but there are unstaged changes, ask to stage all and commit
      if (this.status.staged.length === 0 && (this.status.unstaged.length > 0 || this.status.untracked.length > 0)) {
        const ok = await askConfirm('No staged changes. Stage all changes and commit?', 'Stage All & Commit');
        if (!ok) return;
        await api.gitStage(root, ['.']);
      }

      await api.gitCommit(root, msg);
      this.commitMsg = '';
      await this.refresh();
    } catch (e) {
      this.handlers.onError(`Commit failed: ${e}`);
    }
  }

  async push() {
    const root = this.handlers.getRoot();
    if (!root) return;
    try {
      await api.gitPush(root, this.token);
      await this.refresh();
    } catch (e) {
      this.handlers.onError(`Push failed: ${e}`);
    }
  }

  async pull() {
    const root = this.handlers.getRoot();
    if (!root) return;
    try {
      await api.gitPull(root, this.token);
      await this.refresh();
    } catch (e) {
      this.handlers.onError(`Pull failed: ${e}`);
    }
  }

  async stageFile(file) {
    const root = this.handlers.getRoot();
    if (!root) return;
    try {
      await api.gitStage(root, [file.path]);
      await this.refresh();
    } catch (e) {
      this.handlers.onError(`Stage failed: ${e}`);
    }
  }

  async unstageFile(file) {
    const root = this.handlers.getRoot();
    if (!root) return;
    try {
      await api.gitUnstage(root, [file.path]);
      await this.refresh();
    } catch (e) {
      this.handlers.onError(`Unstage failed: ${e}`);
    }
  }

  async discardFile(file) {
    const root = this.handlers.getRoot();
    if (!root) return;
    const ok = await askConfirm(`Discard changes in ${file.path}? This cannot be undone.`, 'Discard');
    if (!ok) return;
    try {
      await api.gitDiscard(root, [file.path]);
      await this.refresh();
    } catch (e) {
      this.handlers.onError(`Discard failed: ${e}`);
    }
  }

  async switchBranch() {
    const root = this.handlers.getRoot();
    if (!root || !this.status?.is_repo) return;

    try {
      const branches = await api.gitBranches(root);
      const action = await askText(
        `Switch branch (currently on ${this.status.branch}).\nEnter branch name, or prefix with '+' to create new branch:\nAvailable: ${branches.join(', ')}`,
        this.status.branch
      );
      if (!action) return;

      if (action.startsWith('+')) {
        const newBranch = action.slice(1).trim();
        if (newBranch) {
          await api.gitCreateBranch(root, newBranch);
          await this.refresh();
        }
      } else if (action !== this.status.branch) {
        await api.gitCheckout(root, action.trim());
        await this.refresh();
      }
    } catch (e) {
      this.handlers.onError(`Branch switch failed: ${e}`);
    }
  }

  showGitHubModal() {
    const existing = document.getElementById('github-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'github-modal';
    overlay.className = 'modal-overlay';

    overlay.innerHTML = `
      <div class="modal-box">
        <div class="modal-header">
          <span class="modal-title">GitHub Integration</span>
          <button class="icon-button modal-close" id="gh-close">×</button>
        </div>
        <div class="modal-body" id="gh-modal-body">
          ${
            this.githubUser
              ? `
            <div class="gh-profile">
              <img src="${this.githubUser.avatar_url || ''}" class="gh-avatar" alt="Avatar" />
              <div class="gh-info">
                <div class="gh-name">${this.githubUser.name || this.githubUser.login}</div>
                <div class="gh-login">@${this.githubUser.login}</div>
                <div class="gh-meta">${this.githubUser.public_repos ?? 0} public repos</div>
              </div>
            </div>
            <div class="modal-actions" style="margin-top:16px;">
              <button class="btn-secondary" id="gh-clone-btn">Clone Repository...</button>
              <button class="btn-danger" id="gh-logout-btn">Sign Out</button>
            </div>
          `
              : `
            <p style="margin-bottom:12px; color:var(--fg-dim); line-height:1.4;">
              Connect your GitHub account using a Personal Access Token to clone private repositories, pull/push seamlessly, and browse your repos.
            </p>
            <div class="input-group">
              <label style="font-size:11px; color:var(--fg-dim); margin-bottom:4px; display:block;">Personal Access Token (classic or fine-grained with 'repo' scope):</label>
              <input type="password" id="gh-token-input" class="modal-input" placeholder="ghp_..." />
            </div>
            <div class="modal-actions" style="margin-top:16px;">
              <button class="btn-primary" id="gh-save-btn">Connect GitHub</button>
            </div>
            <p style="margin-top:10px; font-size:11px; color:var(--fg-dim);">
              Tokens can be generated at <a href="https://github.com/settings/tokens" target="_blank" style="color:var(--accent);">github.com/settings/tokens</a>
            </p>
          `
          }
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#gh-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const saveBtn = overlay.querySelector('#gh-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const tokenInput = overlay.querySelector('#gh-token-input');
        const token = tokenInput?.value?.trim();
        if (!token) return;
        saveBtn.disabled = true;
        saveBtn.textContent = 'Verifying...';
        try {
          const user = await api.githubGetUser(token);
          this.token = token;
          this.githubUser = user;
          overlay.remove();
          this.render();
        } catch (e) {
          alert(`Failed to verify GitHub token: ${e}`);
          saveBtn.disabled = false;
          saveBtn.textContent = 'Connect GitHub';
        }
      });
    }

    const logoutBtn = overlay.querySelector('#gh-logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        this.token = null;
        this.githubUser = null;
        overlay.remove();
        this.render();
      });
    }

    const cloneBtn = overlay.querySelector('#gh-clone-btn');
    if (cloneBtn) {
      cloneBtn.addEventListener('click', () => {
        overlay.remove();
        this.showCloneModal();
      });
    }
  }

  async showCloneModal() {
    const existing = document.getElementById('clone-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'clone-modal';
    overlay.className = 'modal-overlay';

    overlay.innerHTML = `
      <div class="modal-box" style="width:480px; max-width:90vw;">
        <div class="modal-header">
          <span class="modal-title">Clone Repository from GitHub</span>
          <button class="icon-button modal-close" id="clone-close">×</button>
        </div>
        <div class="modal-body">
          <div class="clone-tabs">
            <button class="clone-tab active" id="tab-url">From URL</button>
            ${this.githubUser ? `<button class="clone-tab" id="tab-repos">Your Repositories</button>` : ''}
          </div>

          <div id="panel-url" class="clone-panel active">
            <label style="font-size:11px; color:var(--fg-dim); margin-bottom:4px; display:block;">Repository URL or owner/name:</label>
            <input type="text" id="clone-url-input" class="modal-input" placeholder="https://github.com/owner/repo or owner/repo" />
          </div>

          ${
            this.githubUser
              ? `
          <div id="panel-repos" class="clone-panel" style="display:none;">
            <input type="text" id="clone-repo-filter" class="modal-input" placeholder="Filter your repositories..." style="margin-bottom:8px;" />
            <div id="clone-repos-list" class="clone-repos-list">
              <div style="padding:12px; color:var(--fg-dim); text-align:center;">Loading repositories...</div>
            </div>
          </div>
          `
              : ''
          }

          <div style="margin-top:12px;">
            <label style="font-size:11px; color:var(--fg-dim); margin-bottom:4px; display:block;">Destination Parent Folder:</label>
            <div style="display:flex; gap:6px;">
              <input type="text" id="clone-dest-input" class="modal-input" value="${this.handlers.getRoot() || ''}" />
            </div>
          </div>

          <div id="clone-status" style="margin-top:12px; font-size:12px; color:var(--fg-dim); display:none;"></div>

          <div class="modal-actions" style="margin-top:16px;">
            <button class="btn-primary" id="btn-do-clone">Clone</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#clone-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const urlTab = overlay.querySelector('#tab-url');
    const reposTab = overlay.querySelector('#tab-repos');
    const urlPanel = overlay.querySelector('#panel-url');
    const reposPanel = overlay.querySelector('#panel-repos');
    const urlInput = overlay.querySelector('#clone-url-input');
    const destInput = overlay.querySelector('#clone-dest-input');
    const doCloneBtn = overlay.querySelector('#btn-do-clone');
    const statusEl = overlay.querySelector('#clone-status');

    if (reposTab && reposPanel) {
      urlTab.addEventListener('click', () => {
        urlTab.classList.add('active');
        reposTab.classList.remove('active');
        urlPanel.style.display = 'block';
        reposPanel.style.display = 'none';
      });

      let loadedRepos = [];
      reposTab.addEventListener('click', async () => {
        reposTab.classList.add('active');
        urlTab.classList.remove('active');
        urlPanel.style.display = 'none';
        reposPanel.style.display = 'block';

        if (loadedRepos.length === 0 && this.token) {
          try {
            loadedRepos = await api.githubListRepos(this.token);
            renderRepoList(loadedRepos);
          } catch (e) {
            overlay.querySelector('#clone-repos-list').innerHTML = `<div style="padding:12px; color:var(--error);">Failed to load repos: ${e}</div>`;
          }
        }
      });

      const filterInput = overlay.querySelector('#clone-repo-filter');
      filterInput?.addEventListener('input', () => {
        const q = filterInput.value.toLowerCase();
        const filtered = loadedRepos.filter((r) => r.full_name.toLowerCase().includes(q));
        renderRepoList(filtered);
      });

      const renderRepoList = (list) => {
        const listEl = overlay.querySelector('#clone-repos-list');
        if (!listEl) return;
        listEl.innerHTML = '';
        if (list.length === 0) {
          listEl.innerHTML = '<div style="padding:12px; color:var(--fg-dim);">No repositories found</div>';
          return;
        }
        for (const repo of list) {
          const item = document.createElement('div');
          item.className = 'clone-repo-item';
          item.innerHTML = `
            <div class="repo-title">
              <strong>${repo.full_name}</strong>
              ${repo.private ? '<span class="badge-private">Private</span>' : ''}
            </div>
            <div class="repo-desc">${repo.description || 'No description'}</div>
          `;
          item.addEventListener('click', () => {
            urlInput.value = repo.clone_url;
            urlTab.click();
          });
          listEl.appendChild(item);
        }
      };
    }

    doCloneBtn.addEventListener('click', async () => {
      const url = urlInput.value.trim();
      const targetParent = destInput.value.trim();
      if (!url) return alert('Please enter a repository URL');
      if (!targetParent) return alert('Please specify a destination folder');

      doCloneBtn.disabled = true;
      doCloneBtn.textContent = 'Cloning...';
      statusEl.style.display = 'block';
      statusEl.textContent = `Cloning repository ${url}... This may take a few moments.`;

      try {
        const targetPath = await api.gitClone(url, targetParent, null, this.token);
        statusEl.textContent = `Successfully cloned into ${targetPath}! Opening folder...`;
        setTimeout(() => {
          overlay.remove();
          this.handlers.onFolderChanged(targetPath);
        }, 600);
      } catch (e) {
        statusEl.textContent = `Clone error: ${e}`;
        statusEl.style.color = 'var(--error)';
        doCloneBtn.disabled = false;
        doCloneBtn.textContent = 'Clone';
      }
    });
  }

  render() {
    this.host.textContent = '';

    const root = this.handlers.getRoot();
    if (!root) {
      const empty = document.createElement('div');
      empty.className = 'git-empty-state';
      empty.innerHTML = `
        <div style="font-size:13px; font-weight:600; margin-bottom:8px;">No Folder Opened</div>
        <p style="color:var(--fg-dim); font-size:12px; margin-bottom:12px;">Open a folder to track changes and manage Git repository.</p>
        <button class="btn-primary" id="btn-git-open-folder">Open Folder</button>
      `;
      this.host.appendChild(empty);
      empty.querySelector('#btn-git-open-folder').addEventListener('click', () => {
        document.getElementById('btn-open')?.click();
      });
      return;
    }

    if (!this.status?.is_repo) {
      const noRepo = document.createElement('div');
      noRepo.className = 'git-empty-state';
      noRepo.innerHTML = `
        <div style="font-size:13px; font-weight:600; margin-bottom:8px;">Not a Git Repository</div>
        <p style="color:var(--fg-dim); font-size:12px; margin-bottom:14px;">The currently opened folder is not configured with Git.</p>
        <button class="btn-primary" id="btn-clone-here" style="margin-bottom:8px; width:100%;">Clone from GitHub</button>
        <button class="btn-secondary" id="btn-connect-gh" style="width:100%;">${this.githubUser ? `GitHub: @${this.githubUser.login}` : 'Connect GitHub Account'}</button>
      `;
      this.host.appendChild(noRepo);
      noRepo.querySelector('#btn-clone-here').addEventListener('click', () => this.showCloneModal());
      noRepo.querySelector('#btn-connect-gh').addEventListener('click', () => this.showGitHubModal());
      return;
    }

    // ── Header Toolbar ──
    const header = document.createElement('div');
    header.className = 'git-header';

    const branchBtn = document.createElement('button');
    branchBtn.className = 'git-branch-pill';
    branchBtn.title = `Current branch: ${this.status.branch}. Click to switch or create branch.`;
    branchBtn.innerHTML = `${SVG_ICONS.branch} <span class="branch-name">${this.status.branch || 'main'}</span>`;
    branchBtn.addEventListener('click', () => this.switchBranch());
    header.appendChild(branchBtn);

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    header.appendChild(spacer);

    // Pull button
    const pullBtn = document.createElement('button');
    pullBtn.className = 'icon-button';
    pullBtn.title = `Pull from remote ${this.status.behind > 0 ? `(${this.status.behind} commits behind)` : ''}`;
    pullBtn.innerHTML = `↓`;
    pullBtn.addEventListener('click', () => this.pull());
    header.appendChild(pullBtn);

    // Push button
    const pushBtn = document.createElement('button');
    pushBtn.className = 'icon-button';
    pushBtn.title = `Push to remote ${this.status.ahead > 0 ? `(${this.status.ahead} commits ahead)` : ''}`;
    pushBtn.innerHTML = `↑`;
    pushBtn.addEventListener('click', () => this.push());
    header.appendChild(pushBtn);

    // Refresh button
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'icon-button';
    refreshBtn.title = 'Refresh status';
    refreshBtn.innerHTML = `⟳`;
    refreshBtn.addEventListener('click', () => this.refresh());
    header.appendChild(refreshBtn);

    // GitHub menu
    const ghBtn = document.createElement('button');
    ghBtn.className = 'icon-button';
    ghBtn.title = this.githubUser ? `GitHub: @${this.githubUser.login}` : 'GitHub Options';
    ghBtn.innerHTML = SVG_ICONS.github;
    ghBtn.addEventListener('click', () => this.showGitHubModal());
    header.appendChild(ghBtn);

    this.host.appendChild(header);

    // ── Commit section ──
    const commitSection = document.createElement('div');
    commitSection.className = 'git-commit-box';

    const textarea = document.createElement('textarea');
    textarea.className = 'git-commit-input';
    textarea.placeholder = 'Message (Ctrl+Enter to commit)';
    textarea.value = this.commitMsg;
    textarea.rows = 2;
    textarea.addEventListener('input', (e) => {
      this.commitMsg = e.target.value;
    });
    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this.commit();
      }
    });
    commitSection.appendChild(textarea);

    const commitActions = document.createElement('div');
    commitActions.className = 'git-commit-actions';

    const commitBtn = document.createElement('button');
    commitBtn.className = 'btn-primary';
    commitBtn.style.flex = '1';
    const stagedCount = this.status.staged.length;
    commitBtn.innerHTML = `${SVG_ICONS.check} Commit ${stagedCount > 0 ? `(${stagedCount})` : ''}`;
    commitBtn.addEventListener('click', () => this.commit());
    commitActions.appendChild(commitBtn);

    commitSection.appendChild(commitActions);
    this.host.appendChild(commitSection);

    // ── Ahead / Behind Sync Bar ──
    if (this.status.ahead > 0 || this.status.behind > 0) {
      const syncBar = document.createElement('div');
      syncBar.className = 'git-sync-bar';
      syncBar.innerHTML = `
        <span>Sync: ${this.status.ahead}↑ ${this.status.behind}↓</span>
        <button class="git-sync-btn" id="btn-sync-changes">Sync Changes</button>
      `;
      syncBar.querySelector('#btn-sync-changes').addEventListener('click', async () => {
        if (this.status.behind > 0) await this.pull();
        if (this.status.ahead > 0) await this.push();
      });
      this.host.appendChild(syncBar);
    }

    // ── Changes Sections ──
    const totalChanges = this.status.total_changes;
    if (totalChanges === 0) {
      const clean = document.createElement('div');
      clean.className = 'git-clean-message';
      clean.textContent = 'Working tree clean, no changes detected.';
      this.host.appendChild(clean);
    } else {
      // 1. Staged Changes
      if (this.status.staged.length > 0) {
        this.renderSection('Staged Changes', this.status.staged, {
          onActionAll: () => api.gitUnstage(root, ['.']).then(() => this.refresh()),
          actionAllTitle: 'Unstage All',
          actionAllIcon: '-',
          itemAction: (file) => this.unstageFile(file),
          itemActionTitle: 'Unstage',
          itemActionIcon: '-',
        });
      }

      // 2. Changes (modified/deleted unstaged)
      if (this.status.unstaged.length > 0) {
        this.renderSection('Changes', this.status.unstaged, {
          onActionAll: () => api.gitStage(root, ['.']).then(() => this.refresh()),
          actionAllTitle: 'Stage All',
          actionAllIcon: '+',
          itemAction: (file) => this.stageFile(file),
          itemActionTitle: 'Stage',
          itemActionIcon: '+',
          discardAction: (file) => this.discardFile(file),
        });
      }

      // 3. Untracked Files
      if (this.status.untracked.length > 0) {
        this.renderSection('Untracked', this.status.untracked, {
          onActionAll: () => api.gitStage(root, ['.']).then(() => this.refresh()),
          actionAllTitle: 'Stage All',
          actionAllIcon: '+',
          itemAction: (file) => this.stageFile(file),
          itemActionTitle: 'Stage',
          itemActionIcon: '+',
          discardAction: (file) => this.discardFile(file),
        });
      }
    }
  }

  renderSection(title, files, config) {
    const sec = document.createElement('div');
    sec.className = 'git-section';

    const secHeader = document.createElement('div');
    secHeader.className = 'git-section-header';
    secHeader.innerHTML = `
      <span class="git-sec-title">${title} <span class="git-count-badge">${files.length}</span></span>
      <span style="flex:1"></span>
      ${
        config.onActionAll
          ? `<button class="icon-button mini-btn" title="${config.actionAllTitle}">${config.actionAllIcon}</button>`
          : ''
      }
    `;

    if (config.onActionAll) {
      secHeader.querySelector('button')?.addEventListener('click', (e) => {
        e.stopPropagation();
        config.onActionAll();
      });
    }
    sec.appendChild(secHeader);

    const fileList = document.createElement('div');
    fileList.className = 'git-file-list';

    for (const file of files) {
      const row = document.createElement('div');
      row.className = 'git-file-row';
      row.title = file.path;

      const badgeChar = file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : file.status === 'untracked' ? 'U' : 'M';
      const badgeClass = `git-badge-${badgeChar.toLowerCase()}`;

      const namePart = api.basename(file.path);
      const dirPart = api.dirname(file.path);

      row.innerHTML = `
        <span class="git-status-badge ${badgeClass}">${badgeChar}</span>
        <span class="git-file-name">${namePart}</span>
        <span class="git-file-dir">${dirPart === '/' ? '' : dirPart}</span>
        <span style="flex:1"></span>
        <div class="git-row-actions">
          ${config.discardAction ? `<button class="icon-button mini-btn btn-discard" title="Discard Changes">↺</button>` : ''}
          <button class="icon-button mini-btn btn-action" title="${config.itemActionTitle}">${config.itemActionIcon}</button>
        </div>
      `;

      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        this.handlers.onOpenDiff(file);
      });

      row.querySelector('.btn-action')?.addEventListener('click', (e) => {
        e.stopPropagation();
        config.itemAction(file);
      });

      row.querySelector('.btn-discard')?.addEventListener('click', (e) => {
        e.stopPropagation();
        config.discardAction(file);
      });

      fileList.appendChild(row);
    }

    sec.appendChild(fileList);
    this.host.appendChild(sec);
  }
}
