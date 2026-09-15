/** Monaco setup: worker wiring, language detection and the tab model store. */

import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { setupCompletions } from './completions.js';

// Vite bundles each worker separately; Monaco asks for them by label.
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

const EXTRA_LANGUAGES = {
  // Extensions Monaco does not map on its own.
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  zsh: 'shell',
  bash: 'shell',
  gradle: 'java',
  lock: 'plaintext',
  env: 'plaintext',
};

/** Best-effort language id for a path, using Monaco's own extension registry. */
export function languageFor(path) {
  const name = path.split(/[\\/]/).pop() || '';
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';

  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === lower)) return lang.id;
    if (lang.extensions?.some((e) => e.toLowerCase() === '.' + ext)) return lang.id;
  }
  return EXTRA_LANGUAGES[ext] || 'plaintext';
}

export function createEditor(container) {
  return monaco.editor.create(container, {
    value: '',
    language: 'plaintext',
    theme: 'vs-dark',
    fontSize: 14,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono-font').trim(),
    minimap: { enabled: window.innerWidth > 900 }, // re-evaluated on resize
    scrollBeyondLastLine: false,
    automaticLayout: true,
    tabSize: 2,
    wordWrap: 'on',
    renderWhitespace: 'selection',
    smoothScrolling: true,
    mouseWheelZoom: true,
    padding: { top: 8 },

    // Autocomplete & IntelliSense
    quickSuggestions: {
      other: true,
      comments: true,
      strings: true,
    },
    quickSuggestionsDelay: 10,
    suggestOnTriggerCharacters: true,
    acceptSuggestionOnEnter: 'on',
    tabCompletion: 'on',
    wordBasedSuggestions: 'allDocuments',
    snippetSuggestions: 'top',
    suggest: {
      filterGraceful: true,
      snippetsPreventQuickSuggestions: false,
      localityBonus: true,
      shareSuggestSelections: true,
      showIcons: true,
      showStatusBar: true,
      preview: true,
      previewMode: 'prefix',
      insertMode: 'insert',
    },
    parameterHints: {
      enabled: true,
      cycle: true,
    },
    autoClosingBrackets: 'always',
    autoClosingQuotes: 'always',
    autoClosingComments: 'always',
    autoSurround: 'languageDefined',
    formatOnType: true,
    formatOnPaste: true,
  });
}

export function createModel(content, path) {
  return monaco.editor.createModel(content, languageFor(path));
}

export { monaco, setupCompletions };
