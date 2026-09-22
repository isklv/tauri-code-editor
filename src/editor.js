/** Monaco setup: worker wiring, language detection and the tab model store. */

import * as monaco from 'monaco-editor';
import 'monaco-editor/min/vs/editor/editor.main.css';
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
  const ed = monaco.editor.create(container, {
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
    // Monaco sizes the suggest/hover widgets against the whole page but renders
    // them inside `.editor`, which clips its overflow. On a phone the editor box
    // is only a few lines tall once the keyboard is up, so the widget gets sized
    // for the page and then clipped away to nothing. Positioning the overflow
    // widgets fixed lets them escape that box.
    fixedOverflowWidgets: true,
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
    suggestFontSize: 13,
    suggestLineHeight: 22,
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

  try {
    monaco.editor.registerOpener?.({
      openExternal(uri) {
        const url = typeof uri === 'string' ? uri : uri.toString();
        if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
          window.dispatchEvent(new CustomEvent('geko:open-link', { detail: { url } }));
          return true;
        }
        return false;
      },
    });
  } catch {}

  return ed;
}

/**
 * Android soft keyboards compose as you type, and Monaco reads the `<textarea>`
 * from inside `compositionupdate` -- an event Chromium fires *before* the
 * composed text lands in the field. The editor therefore always sees the state
 * from the previous keystroke: the first character of a word stays invisible
 * until the second one pushes it through, and the caret trails the text by one
 * character. `input` fires once the value is there, but Monaco ignores it while
 * a composition is running, so re-emit the composition event from `input` to
 * make Monaco re-read the field at a point where it holds the real value.
 */
export function fixAndroidComposition(target) {
  if (!/Android/.test(navigator.userAgent)) return;

  const attach = () => {
    const textarea = target.getDomNode()?.querySelector('textarea.inputarea');
    // `setModel(null)` makes Monaco throw its whole view away, textarea and all,
    // and build a fresh one for the next model -- so this has to run again for
    // every model, and skip textareas it has already seen.
    if (!textarea || textarea.dataset.androidComposition) return;
    textarea.dataset.androidComposition = 'patched';

    let composing = false;
    // Monaco registered its own listeners when the view was built, so these run
    // after its handlers have already seen (and mishandled) the event.
    textarea.addEventListener('compositionstart', () => {
      composing = true;
    });
    textarea.addEventListener('compositionend', () => {
      composing = false;
    });
    textarea.addEventListener('input', () => {
      if (!composing) return;
      textarea.dispatchEvent(
        new CompositionEvent('compositionupdate', { data: textarea.value, bubbles: true }),
      );
    });
  };

  attach();
  target.onDidChangeModel(attach);
}

export function createModel(content, path, uri) {
  const modelUri = uri ?? (path ? monaco.Uri.file(path) : undefined);
  if (modelUri) {
    const existing = monaco.editor.getModel(modelUri);
    if (existing) existing.dispose();
    return monaco.editor.createModel(content, languageFor(path), modelUri);
  }
  return monaco.editor.createModel(content, languageFor(path));
}

export function createDiffEditor(container) {
  return monaco.editor.createDiffEditor(container, {
    originalEditable: false,
    readOnly: false,
    theme: 'vs-dark',
    fontSize: 14,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono-font').trim(),
    automaticLayout: true,
    renderSideBySide: window.innerWidth > 750,
    smoothScrolling: true,
  });
}

export { monaco, setupCompletions };
