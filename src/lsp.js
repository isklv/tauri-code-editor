/**
 * Language Server Protocol (LSP) Client for Monaco Editor.
 *
 * Connects Monaco to background language servers (gopls, pyright, rust-analyzer,
 * typescript-language-server) running either natively on the host or inside
 * the Alpine Linux PRoot environment.
 *
 * Supported capabilities:
 * - Document lifecycle synchronization (didOpen, didChange, didSave, didClose)
 * - Autocompletion with snippet support and resolve (textDocument/completion)
 * - Hover tooltips and documentation (textDocument/hover)
 * - Diagnostic errors and warnings as Monaco markers (textDocument/publishDiagnostics)
 * - Signature help (textDocument/signatureHelp)
 */

import * as api from './api.js';

/** Supported language IDs mapped to LSP servers. */
const SUPPORTED_LANGUAGES = new Set(['go', 'python', 'rust', 'typescript', 'javascript']);

/** LSP CompletionItemKind -> Monaco CompletionItemKind mapping */
function getKindMap(monaco) {
  const K = monaco.languages.CompletionItemKind;
  return {
    1: K.Text,
    2: K.Method,
    3: K.Function,
    4: K.Constructor,
    5: K.Field,
    6: K.Variable,
    7: K.Class,
    8: K.Interface,
    9: K.Module,
    10: K.Property,
    11: K.Unit,
    12: K.Value,
    13: K.Enum,
    14: K.Keyword,
    15: K.Snippet,
    16: K.Color,
    17: K.File,
    18: K.Reference,
    19: K.Folder,
    20: K.EnumMember,
    21: K.Constant,
    22: K.Struct,
    23: K.Event,
    24: K.Operator,
    25: K.TypeParameter,
  };
}

/** LSP DiagnosticSeverity -> Monaco MarkerSeverity mapping */
function getSeverityMap(monaco) {
  const S = monaco.MarkerSeverity;
  return {
    1: S.Error,
    2: S.Warning,
    3: S.Info,
    4: S.Hint,
  };
}

export class LspClient {
  /**
   * @param {typeof import('monaco-editor')} monaco
   * @param {{ getRootPath: () => string | null, onStatus?: (text: string) => void }} options
   */
  constructor(monaco, options) {
    this.monaco = monaco;
    this.options = options;
    this.kindMap = getKindMap(monaco);
    this.severityMap = getSeverityMap(monaco);

    this.servers = new Map(); // lang -> { status: 'starting'|'ready'|'failed', pending: Map<id, { resolve, reject, timer }>, nextId: 1 }
    this.docVersions = new Map(); // uri -> version number
    this.changeDebounce = new Map(); // uri -> timeout ID
    this.modelDisposables = new Map(); // uri -> IDisposable[]
    this.unsubscribeMsg = null;

    this.init();
  }

  async init() {
    if (!api.isTauri) return;

    // Listen for incoming LSP JSON-RPC messages from Rust backend
    this.unsubscribeMsg = await api.onLspMessage(({ lang, message }) => {
      this.handleServerMessage(lang, message);
    });

    // Register Monaco providers for each supported language
    for (const lang of SUPPORTED_LANGUAGES) {
      this.registerLanguageProviders(lang);
    }

    // Monitor Monaco model creation and destruction
    this.monaco.editor.onDidCreateModel((model) => this.attachModel(model));
    this.monaco.editor.getModels().forEach((model) => this.attachModel(model));
  }

  /** Normalizes a model URI to standard file:// format */
  getModelUri(model) {
    const raw = model.uri.toString();
    if (raw.startsWith('file://')) return raw;
    if (model.uri.path) return `file://${model.uri.path}`;
    return raw;
  }

  /**
   * Ensure a language server is running and initialized for the given language.
   * @param {string} lang
   * @returns {Promise<boolean>}
   */
  async ensureServer(lang) {
    if (!SUPPORTED_LANGUAGES.has(lang)) return false;

    let server = this.servers.get(lang);
    if (server) {
      if (server.status === 'ready') return true;
      if (server.status === 'starting') {
        try {
          await server.initPromise;
          return server.status === 'ready';
        } catch {
          return false;
        }
      }
      if (server.status === 'failed') return false;
    }

    server = {
      status: 'starting',
      pending: new Map(),
      nextId: 1,
      initPromise: null,
    };
    this.servers.set(lang, server);

    server.initPromise = (async () => {
      try {
        const root = this.options.getRootPath() || '';
        await api.lspStart(lang, root);

        // Send LSP initialize request
        const rootUri = root ? `file://${root}` : null;
        const initResult = await this.sendRequest(lang, 'initialize', {
          processId: null,
          rootUri,
          rootPath: root || null,
          capabilities: {
            textDocument: {
              synchronization: {
                dynamicRegistration: true,
                willSave: false,
                willSaveWaitUntil: false,
                didSave: true,
              },
              completion: {
                dynamicRegistration: true,
                completionItem: {
                  snippetSupport: true,
                  commitCharactersSupport: true,
                  documentationFormat: ['markdown', 'plaintext'],
                  deprecatedSupport: true,
                  preselectSupport: true,
                },
                contextSupport: true,
              },
              hover: {
                dynamicRegistration: true,
                contentFormat: ['markdown', 'plaintext'],
              },
              publishDiagnostics: {
                relatedInformation: true,
              },
              signatureHelp: {
                dynamicRegistration: true,
                signatureInformation: {
                  documentationFormat: ['markdown', 'plaintext'],
                },
              },
            },
            workspace: {
              workspaceFolders: true,
            },
          },
          workspaceFolders: rootUri ? [{ uri: rootUri, name: 'workspace' }] : [],
        }, 10000);

        // Send initialized notification
        await this.sendNotification(lang, 'initialized', {});
        server.status = 'ready';
        return true;
      } catch (err) {
        console.warn(`[LSP] Failed to initialize ${lang} language server:`, err);
        server.status = 'failed';
        throw err;
      }
    })();

    try {
      await server.initPromise;
      return server.status === 'ready';
    } catch {
      return false;
    }
  }

  /**
   * Sends a JSON-RPC request to the language server and returns a promise.
   */
  sendRequest(lang, method, params, timeoutMs = 4000) {
    const server = this.servers.get(lang);
    if (!server) return Promise.reject(new Error(`Server not found: ${lang}`));

    const id = server.nextId++;
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (server.pending.has(id)) {
          server.pending.delete(id);
          reject(new Error(`LSP request ${method} timed out`));
        }
      }, timeoutMs);

      server.pending.set(id, { resolve, reject, timer });

      api.lspSend(lang, payload).catch((err) => {
        clearTimeout(timer);
        server.pending.delete(id);
        reject(err);
      });
    });
  }

  /**
   * Sends a JSON-RPC notification to the language server.
   */
  async sendNotification(lang, method, params) {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    });
    try {
      await api.lspSend(lang, payload);
    } catch (e) {
      console.warn(`[LSP] Notification ${method} failed:`, e);
    }
  }

  /**
   * Handles messages received from the language server stdio.
   */
  handleServerMessage(lang, messageStr) {
    let msg;
    try {
      msg = JSON.parse(messageStr);
    } catch (e) {
      console.warn('[LSP] Malformed message:', e, messageStr);
      return;
    }

    const server = this.servers.get(lang);
    if (!server) return;

    // Response to a request
    if (msg.id !== undefined && server.pending.has(msg.id)) {
      const { resolve, reject, timer } = server.pending.get(msg.id);
      clearTimeout(timer);
      server.pending.delete(msg.id);

      if (msg.error) {
        reject(new Error(msg.error.message || 'LSP error'));
      } else {
        resolve(msg.result);
      }
      return;
    }

    // Server Notification
    if (msg.method) {
      this.handleNotification(lang, msg.method, msg.params);
    }
  }

  handleNotification(lang, method, params) {
    if (method === 'textDocument/publishDiagnostics') {
      const { uri, diagnostics } = params;
      this.applyDiagnostics(uri, diagnostics, lang);
    }
  }

  applyDiagnostics(uri, diagnostics, lang) {
    const targetUri = this.monaco.Uri.parse(uri);
    const model = this.monaco.editor.getModel(targetUri);
    if (!model) return;

    const markers = (diagnostics || []).map((diag) => ({
      severity: this.severityMap[diag.severity] ?? this.monaco.MarkerSeverity.Error,
      message: diag.message,
      startLineNumber: (diag.range?.start?.line ?? 0) + 1,
      startColumn: (diag.range?.start?.character ?? 0) + 1,
      endLineNumber: (diag.range?.end?.line ?? diag.range?.start?.line ?? 0) + 1,
      endColumn: (diag.range?.end?.character ?? (diag.range?.start?.character ?? 0) + 1) + 1,
      source: diag.source || lang,
      code: typeof diag.code === 'object' ? diag.code.value : String(diag.code ?? ''),
    }));

    this.monaco.editor.setModelMarkers(model, 'lsp', markers);
  }

  /**
   * Attach LSP tracking to a Monaco model.
   */
  async attachModel(model) {
    const lang = model.getLanguageId();
    if (!SUPPORTED_LANGUAGES.has(lang)) return;

    const uri = this.getModelUri(model);
    if (this.modelDisposables.has(uri)) return;

    const disposables = [];

    // Ensure server is started
    const ready = await this.ensureServer(lang);
    if (!ready) return;

    // Send didOpen
    const version = 1;
    this.docVersions.set(uri, version);

    await this.sendNotification(lang, 'textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: lang,
        version,
        text: model.getValue(),
      },
    });

    // Send didChange on edits (debounced by 150ms)
    disposables.push(
      model.onDidChangeContent(() => {
        if (this.changeDebounce.has(uri)) {
          clearTimeout(this.changeDebounce.get(uri));
        }

        const timer = setTimeout(async () => {
          this.changeDebounce.delete(uri);
          const v = (this.docVersions.get(uri) || 1) + 1;
          this.docVersions.set(uri, v);

          await this.sendNotification(lang, 'textDocument/didChange', {
            textDocument: {
              uri,
              version: v,
            },
            contentChanges: [{ text: model.getValue() }],
          });
        }, 150);

        this.changeDebounce.set(uri, timer);
      }),
    );

    // Clean up when model is disposed
    disposables.push(
      model.onWillDispose(async () => {
        if (this.changeDebounce.has(uri)) {
          clearTimeout(this.changeDebounce.get(uri));
          this.changeDebounce.delete(uri);
        }
        this.docVersions.delete(uri);
        this.monaco.editor.setModelMarkers(model, 'lsp', []);

        await this.sendNotification(lang, 'textDocument/didClose', {
          textDocument: { uri },
        });

        const subs = this.modelDisposables.get(uri);
        if (subs) {
          subs.forEach((d) => d.dispose?.());
          this.modelDisposables.delete(uri);
        }
      }),
    );

    this.modelDisposables.set(uri, disposables);
  }

  /**
   * Notify language server that a document was saved.
   */
  async notifySave(model) {
    if (!model) return;
    const lang = model.getLanguageId();
    if (!SUPPORTED_LANGUAGES.has(lang)) return;
    const uri = this.getModelUri(model);
    await this.sendNotification(lang, 'textDocument/didSave', {
      textDocument: { uri },
    });
  }

  /**
   * Register completion, hover, and signature help providers for Monaco.
   */
  registerLanguageProviders(lang) {
    // 1. Completion Provider
    this.monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ['.', ':', '<', '"', '/', '@', '*', '>', '&'],
      provideCompletionItems: async (model, position) => {
        try {
          const ready = await this.ensureServer(lang);
          if (!ready) return { suggestions: [] };

          const uri = this.getModelUri(model);
          const result = await this.sendRequest(lang, 'textDocument/completion', {
            textDocument: { uri },
            position: {
              line: position.lineNumber - 1,
              character: position.column - 1,
            },
            context: {
              triggerKind: 1,
            },
          });

          if (!result) return { suggestions: [] };
          const items = Array.isArray(result) ? result : result.items || [];

          const suggestions = items.map((item) => {
            const label = typeof item.label === 'string' ? item.label : item.label?.label || '';
            const insertText = item.insertText || (item.textEdit?.newText ?? label);

            let insertTextRules = 0;
            if (item.insertTextFormat === 2) {
              insertTextRules = this.monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
            }

            let range = undefined;
            if (item.textEdit?.range) {
              const r = item.textEdit.range;
              range = {
                startLineNumber: r.start.line + 1,
                startColumn: r.start.character + 1,
                endLineNumber: r.end.line + 1,
                endColumn: r.end.character + 1,
              };
            }

            let doc = undefined;
            if (typeof item.documentation === 'string') {
              doc = { value: item.documentation };
            } else if (item.documentation?.value) {
              doc = { value: item.documentation.value };
            }

            return {
              label,
              kind: this.kindMap[item.kind] ?? this.monaco.languages.CompletionItemKind.Property,
              detail: item.detail,
              documentation: doc,
              insertText,
              insertTextRules,
              range,
              sortText: item.sortText,
              filterText: item.filterText,
            };
          });

          return {
            suggestions,
            isIncomplete: !Array.isArray(result) && !!result.isIncomplete,
          };
        } catch (e) {
          return { suggestions: [] };
        }
      },
    });

    // 2. Hover Provider
    this.monaco.languages.registerHoverProvider(lang, {
      provideHover: async (model, position) => {
        try {
          const ready = await this.ensureServer(lang);
          if (!ready) return null;

          const uri = this.getModelUri(model);
          const result = await this.sendRequest(lang, 'textDocument/hover', {
            textDocument: { uri },
            position: {
              line: position.lineNumber - 1,
              character: position.column - 1,
            },
          });

          if (!result || !result.contents) return null;

          const contents = [];
          const raw = result.contents;

          if (typeof raw === 'string') {
            contents.push({ value: raw });
          } else if (Array.isArray(raw)) {
            for (const item of raw) {
              if (typeof item === 'string') contents.push({ value: item });
              else if (item.value) contents.push({ value: item.value });
            }
          } else if (raw.value) {
            contents.push({ value: raw.value });
          }

          let range = undefined;
          if (result.range) {
            range = {
              startLineNumber: result.range.start.line + 1,
              startColumn: result.range.start.character + 1,
              endLineNumber: result.range.end.line + 1,
              endColumn: result.range.end.character + 1,
            };
          }

          return { contents, range };
        } catch (e) {
          return null;
        }
      },
    });

    // 3. Signature Help Provider
    this.monaco.languages.registerSignatureHelpProvider(lang, {
      signatureHelpTriggerCharacters: ['(', ','],
      provideSignatureHelp: async (model, position) => {
        try {
          const ready = await this.ensureServer(lang);
          if (!ready) return null;

          const uri = this.getModelUri(model);
          const result = await this.sendRequest(lang, 'textDocument/signatureHelp', {
            textDocument: { uri },
            position: {
              line: position.lineNumber - 1,
              character: position.column - 1,
            },
          });

          if (!result || !result.signatures) return null;

          return {
            value: {
              activeSignature: result.activeSignature || 0,
              activeParameter: result.activeParameter || 0,
              signatures: result.signatures.map((sig) => ({
                label: sig.label,
                documentation: typeof sig.documentation === 'string'
                  ? sig.documentation
                  : sig.documentation?.value,
                parameters: (sig.parameters || []).map((p) => ({
                  label: p.label,
                  documentation: typeof p.documentation === 'string'
                    ? p.documentation
                    : p.documentation?.value,
                })),
              })),
            },
            dispose: () => {},
          };
        } catch (e) {
          return null;
        }
      },
    });
  }

  /** Clean shutdown of all language servers. */
  async dispose() {
    if (this.unsubscribeMsg) {
      this.unsubscribeMsg();
      this.unsubscribeMsg = null;
    }
    for (const lang of this.servers.keys()) {
      await api.lspStop(lang).catch(() => {});
    }
    this.servers.clear();
  }
}

/**
 * Initializes LSP integration for Monaco.
 * @param {typeof import('monaco-editor')} monaco
 * @param {{ getRootPath: () => string | null }} options
 */
export function setupLsp(monaco, options) {
  return new LspClient(monaco, options);
}
