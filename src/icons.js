/**
 * File, folder, and activity icons for the VS Code style UI.
 */

const EXT_ICONS = {
  js: { color: '#f7df1e', badge: 'JS' },
  mjs: { color: '#f7df1e', badge: 'JS' },
  cjs: { color: '#f7df1e', badge: 'JS' },
  ts: { color: '#3178c6', badge: 'TS' },
  mts: { color: '#3178c6', badge: 'TS' },
  cts: { color: '#3178c6', badge: 'TS' },
  jsx: { color: '#61dafb', badge: 'JSX' },
  tsx: { color: '#3178c6', badge: 'TSX' },
  html: { color: '#e34f26', badge: 'HTML' },
  htm: { color: '#e34f26', badge: 'HTM' },
  css: { color: '#1572b6', badge: 'CSS' },
  scss: { color: '#c6538c', badge: 'SCSS' },
  sass: { color: '#c6538c', badge: 'SASS' },
  less: { color: '#1d365d', badge: 'LESS' },
  json: { color: '#cbcb41', badge: '{}' },
  json5: { color: '#cbcb41', badge: '{}' },
  rs: { color: '#dea584', badge: 'RS' },
  py: { color: '#3572a5', badge: 'PY' },
  go: { color: '#00add8', badge: 'GO' },
  c: { color: '#555555', badge: 'C' },
  cpp: { color: '#f34b7d', badge: 'C++' },
  cc: { color: '#f34b7d', badge: 'C++' },
  cxx: { color: '#f34b7d', badge: 'C++' },
  h: { color: '#a074c4', badge: 'H' },
  hpp: { color: '#a074c4', badge: 'H++' },
  java: { color: '#b07219', badge: 'JV' },
  kt: { color: '#a97bff', badge: 'KT' },
  sh: { color: '#4eaa25', badge: 'SH' },
  bash: { color: '#4eaa25', badge: 'SH' },
  zsh: { color: '#4eaa25', badge: 'SH' },
  md: { color: '#519aba', badge: 'MD' },
  markdown: { color: '#519aba', badge: 'MD' },
  toml: { color: '#9c4221', badge: 'TOML' },
  yaml: { color: '#cb171e', badge: 'YML' },
  yml: { color: '#cb171e', badge: 'YML' },
  xml: { color: '#e37933', badge: 'XML' },
  svg: { color: '#ffb13b', badge: 'SVG' },
  png: { color: '#20c997', badge: 'PNG' },
  jpg: { color: '#20c997', badge: 'JPG' },
  jpeg: { color: '#20c997', badge: 'JPG' },
  gif: { color: '#20c997', badge: 'GIF' },
  webp: { color: '#20c997', badge: 'WEBP' },
  ico: { color: '#ffb13b', badge: 'ICO' },
  sql: { color: '#e38c00', badge: 'SQL' },
  txt: { color: '#888888', badge: 'TXT' },
  lock: { color: '#7f8c8d', badge: '🔒' },
};

const EXACT_ICONS = {
  'package.json': { color: '#cb3837', badge: 'NPM' },
  'cargo.toml': { color: '#dea584', badge: 'CRG' },
  'cargo.lock': { color: '#7f8c8d', badge: '🔒' },
  '.gitignore': { color: '#f05032', badge: 'GIT' },
  '.gitmodules': { color: '#f05032', badge: 'GIT' },
  'dockerfile': { color: '#2496ed', badge: 'DCK' },
  'readme.md': { color: '#519aba', badge: 'INFO' },
  'license': { color: '#d4af37', badge: 'LIC' },
  'license.md': { color: '#d4af37', badge: 'LIC' },
  'license.txt': { color: '#d4af37', badge: 'LIC' },
};

/**
 * Returns HTML string for an icon representing `name`.
 * @param {string} name
 * @param {boolean} isDir
 * @param {boolean} isExpanded
 */
export function getFileIconHtml(name, isDir = false, isExpanded = false) {
  if (isDir) {
    if (isExpanded) {
      return `<span class="codicon-folder-open" style="color: #dcb67a;">📂</span>`;
    }
    return `<span class="codicon-folder" style="color: #dcb67a;">📁</span>`;
  }

  const lower = name.toLowerCase();
  if (EXACT_ICONS[lower]) {
    const item = EXACT_ICONS[lower];
    return `<span class="file-icon-badge" style="background:${item.color}22; color:${item.color}; border:1px solid ${item.color}66">${item.badge}</span>`;
  }

  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  if (EXT_ICONS[ext]) {
    const item = EXT_ICONS[ext];
    return `<span class="file-icon-badge" style="background:${item.color}22; color:${item.color}; border:1px solid ${item.color}66">${item.badge}</span>`;
  }

  return `<span class="file-icon-generic" style="color:#858585;">📄</span>`;
}

export const SVG_ICONS = {
  explorer: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`,
  search: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
  git: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 9v12"/><path d="M18 15a9 9 0 0 0-9-9H6"/></svg>`,
  terminal: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>`,
  settings: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>`,
  github: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12Z"/></svg>`,
  branch: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`,
  sync: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>`,
  check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  minus: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  discard: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`,
  refresh: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>`,
  close: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  save: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`,
  folder: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`,
  menu: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`,
  chevronDown: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
};
