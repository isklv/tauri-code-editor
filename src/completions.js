/**
 * Autocompletion and IntelliSense configuration for Monaco Editor.
 *
 * Provides:
 * - Quick suggestions and snippet completions for major programming languages
 * - Standard library builtins, keywords, and control structures
 * - File and directory path autocompletion inside quotes (e.g. `./`, `../`)
 * - TypeScript / JavaScript IntelliSense compiler options and sync
 */

import * as api from './api.js';

/**
 * Configure autocompletion, language settings, and completion providers.
 * @param {typeof import('monaco-editor')} monaco
 * @param {{
 *   getActivePath: () => string | null,
 *   getRootPath: () => string | null,
 * }} context
 */
export function setupCompletions(monaco, context) {
  configureTypeScript(monaco);
  registerLanguageSnippets(monaco);
  registerPathCompletion(monaco, context);
}

function configureTypeScript(monaco) {
  const compilerOptions = {
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    allowNonTsExtensions: true,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    module: monaco.languages.typescript.ModuleKind.CommonJS,
    noEmit: true,
    allowJs: true,
    jsx: monaco.languages.typescript.JsxEmit.React,
  };

  monaco.languages.typescript.javascriptDefaults.setCompilerOptions(compilerOptions);
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);

  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });

  monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);
  monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
}

// ── Language Snippets & Keywords ──

const LANGUAGE_DATA = {
  python: {
    keywords: [
      'def', 'class', 'import', 'from', 'return', 'if', 'elif', 'else', 'while', 'for', 'in',
      'try', 'except', 'finally', 'with', 'as', 'lambda', 'yield', 'async', 'await', 'pass',
      'break', 'continue', 'raise', 'assert', 'global', 'nonlocal', 'True', 'False', 'None',
      'match', 'case', 'del', 'self',
    ],
    builtins: [
      'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple', 'bool',
      'enumerate', 'zip', 'map', 'filter', 'open', 'sum', 'min', 'max', 'sorted', 'any', 'all',
      'isinstance', 'issubclass', 'super', 'property', 'staticmethod', 'classmethod', 'input',
      'type', 'abs', 'round', 'id', 'dir', 'hasattr', 'getattr', 'setattr', 'delattr', 'vars',
      'repr', 'iter', 'next', 'callable', 'format', 'reversed', 'slice', 'bytes', 'bytearray',
      'Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError', 'FileNotFoundError',
      'RuntimeError', 'NotImplementedError',
    ],
    snippets: [
      { label: 'def', insertText: 'def ${1:name}(${2:params}):\n\t${3:pass}', detail: 'Function definition' },
      { label: 'defm', insertText: 'def ${1:name}(self${2:, params}):\n\t${3:pass}', detail: 'Method definition' },
      { label: 'class', insertText: 'class ${1:ClassName}:\n\tdef __init__(self${2:, args}):\n\t\t${3:pass}', detail: 'Class definition' },
      { label: 'main', insertText: 'if __name__ == "__main__":\n\t${1:main()}', detail: 'if __name__ == "__main__"' },
      { label: 'for', insertText: 'for ${1:item} in ${2:items}:\n\t${3:pass}', detail: 'For loop' },
      { label: 'fori', insertText: 'for ${1:i} in range(${2:count}):\n\t${3:pass}', detail: 'Indexed for loop' },
      { label: 'with', insertText: 'with open(${1:"file.txt"}, "${2:r}") as ${3:f}:\n\t${4:content = f.read()}', detail: 'with open() file context' },
      { label: 'try', insertText: 'try:\n\t${1:pass}\nexcept ${2:Exception} as ${3:e}:\n\t${4:print(e)}', detail: 'Try-except block' },
      { label: 'tryf', insertText: 'try:\n\t${1:pass}\nexcept ${2:Exception} as ${3:e}:\n\t${4:print(e)}\nfinally:\n\t${5:pass}', detail: 'Try-except-finally' },
      { label: 'adef', insertText: 'async def ${1:name}(${2:params}):\n\t${3:pass}', detail: 'Async function definition' },
      { label: 'listcomp', insertText: '[${1:x} for ${1:x} in ${2:iterable}]', detail: 'List comprehension' },
      { label: 'dictcomp', insertText: '{${1:k}: ${2:v} for ${1:k}, ${2:v} in ${3:iterable}}', detail: 'Dict comprehension' },
      { label: 'lambda', insertText: 'lambda ${1:x}: ${2:expression}', detail: 'Lambda expression' },
      { label: 'doc', insertText: '"""${1:Description}\n\n:param ${2:param}: ${3:description}\n:return: ${4:description}\n"""', detail: 'Docstring' },
    ],
  },

  rust: {
    keywords: [
      'fn', 'let', 'mut', 'pub', 'struct', 'enum', 'impl', 'trait', 'use', 'mod', 'match',
      'if', 'else', 'while', 'loop', 'for', 'in', 'return', 'break', 'continue', 'where',
      'const', 'static', 'type', 'unsafe', 'async', 'await', 'move', 'ref', 'self', 'Self',
      'crate', 'super', 'as', 'dyn', 'extern',
    ],
    builtins: [
      'String', 'str', 'Vec', 'Option', 'Some', 'None', 'Result', 'Ok', 'Err', 'Box', 'Rc',
      'Arc', 'Mutex', 'Cell', 'RefCell', 'HashMap', 'HashSet', 'BTreeMap', 'BTreeSet',
      'Clone', 'Copy', 'Debug', 'Display', 'Default', 'PartialEq', 'Eq', 'PartialOrd', 'Ord',
      'Hash', 'Send', 'Sync', 'From', 'Into', 'Iterator', 'Path', 'PathBuf', 'File',
      'Duration', 'Instant', 'println!', 'eprintln!', 'format!', 'vec!', 'panic!',
      'assert!', 'assert_eq!', 'todo!', 'unimplemented!', 'unreachable!', 'dbg!',
    ],
    snippets: [
      { label: 'fn', insertText: 'fn ${1:name}(${2:params}) -> ${3:Result<(), Box<dyn std::error::Error>>} {\n\t${4:Ok(())}\n}', detail: 'Function definition' },
      { label: 'pfn', insertText: 'pub fn ${1:name}(${2:params}) {\n\t${3}\n}', detail: 'Public function' },
      { label: 'struct', insertText: 'struct ${1:Name} {\n\t${2:pub field: String},\n}', detail: 'Struct definition' },
      { label: 'pstruct', insertText: 'pub struct ${1:Name} {\n\t${2:pub field: String},\n}', detail: 'Public struct' },
      { label: 'enum', insertText: 'enum ${1:Name} {\n\t${2:Variant},\n}', detail: 'Enum definition' },
      { label: 'penum', insertText: 'pub enum ${1:Name} {\n\t${2:Variant},\n}', detail: 'Public enum' },
      { label: 'impl', insertText: 'impl ${1:Name} {\n\tpub fn new(${2}) -> Self {\n\t\tSelf { ${3} }\n\t}\n}', detail: 'Impl block with new()' },
      { label: 'implfor', insertText: 'impl ${1:Trait} for ${2:Type} {\n\t${3}\n}', detail: 'Trait implementation' },
      { label: 'match', insertText: 'match ${1:expr} {\n\t${2:pattern} => ${3:expr},\n\t_ => ${4:()},\n}', detail: 'Match expression' },
      { label: 'iflet', insertText: 'if let Some(${1:val}) = ${2:option} {\n\t${3}\n}', detail: 'if let Some' },
      { label: 'ifletok', insertText: 'if let Ok(${1:val}) = ${2:result} {\n\t${3}\n}', detail: 'if let Ok' },
      { label: 'for', insertText: 'for ${1:item} in ${2:iterator} {\n\t${3}\n}', detail: 'For loop' },
      { label: 'derive', insertText: '#[derive(${1:Debug, Clone, PartialEq})]', detail: 'Derive attribute' },
      { label: 'test', insertText: '#[test]\nfn test_${1:feature}() {\n\tassert_eq!(${2:actual}, ${3:expected});\n}', detail: 'Unit test' },
      { label: 'modtest', insertText: '#[cfg(test)]\nmod tests {\n\tuse super::*;\n\n\t#[test]\n\tfn test_${1:feature}() {\n\t\t${2}\n\t}\n}', detail: 'Test module' },
      { label: 'pln', insertText: 'println!("${1:format}", ${2:args});', detail: 'println! macro' },
      { label: 'eprn', insertText: 'eprintln!("${1:error}", ${2:args});', detail: 'eprintln! macro' },
    ],
  },

  javascript: {
    keywords: [
      'const', 'let', 'var', 'function', 'class', 'import', 'export', 'default', 'from',
      'return', 'if', 'else', 'while', 'for', 'of', 'in', 'switch', 'case', 'break',
      'continue', 'try', 'catch', 'finally', 'throw', 'new', 'this', 'super', 'extends',
      'async', 'await', 'yield', 'typeof', 'instanceof', 'true', 'false', 'null', 'undefined',
    ],
    builtins: [
      'console', 'document', 'window', 'Math', 'JSON', 'Promise', 'Array', 'Object', 'String',
      'Number', 'Boolean', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Error', 'Date', 'RegExp',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'fetch', 'parseInt', 'parseFloat',
    ],
    snippets: [
      { label: 'log', insertText: 'console.log(${1:item});', detail: 'console.log' },
      { label: 'warn', insertText: 'console.warn(${1:item});', detail: 'console.warn' },
      { label: 'err', insertText: 'console.error(${1:err});', detail: 'console.error' },
      { label: 'fn', insertText: 'function ${1:name}(${2:args}) {\n\t${3}\n}', detail: 'Function declaration' },
      { label: 'afn', insertText: 'async function ${1:name}(${2:args}) {\n\t${3}\n}', detail: 'Async function' },
      { label: 'arrow', insertText: 'const ${1:name} = (${2:args}) => {\n\t${3}\n};', detail: 'Arrow function' },
      { label: 'imp', insertText: "import { ${1:name} } from '${2:module}';", detail: 'Named import' },
      { label: 'impall', insertText: "import * as ${1:name} from '${2:module}';", detail: 'Namespace import' },
      { label: 'exp', insertText: 'export default ${1:name};', detail: 'Default export' },
      { label: 'expfn', insertText: 'export function ${1:name}(${2:args}) {\n\t${3}\n}', detail: 'Export function' },
      { label: 'try', insertText: 'try {\n\t${1}\n} catch (err) {\n\t${2:console.error(err);}\n}', detail: 'Try-catch block' },
      { label: 'forof', insertText: 'for (const ${1:item} of ${2:items}) {\n\t${3}\n}', detail: 'For-of loop' },
      { label: 'fori', insertText: 'for (let ${1:i} = 0; ${1:i} < ${2:len}; ${1:i}++) {\n\t${3}\n}', detail: 'For loop' },
      { label: 'prom', insertText: 'new Promise((resolve, reject) => {\n\t${1}\n})', detail: 'new Promise' },
      { label: 'timeout', insertText: 'setTimeout(() => {\n\t${1}\n}, ${2:1000});', detail: 'setTimeout' },
      { label: 'interval', insertText: 'setInterval(() => {\n\t${1}\n}, ${2:1000});', detail: 'setInterval' },
      { label: 'qs', insertText: "document.querySelector('${1:selector}')", detail: 'document.querySelector' },
      { label: 'qsa', insertText: "document.querySelectorAll('${1:selector}')", detail: 'document.querySelectorAll' },
      { label: 'ael', insertText: "addEventListener('${1:click}', (${2:e}) => {\n\t${3}\n});", detail: 'addEventListener' },
      { label: 'jsons', insertText: 'JSON.stringify(${1:object}, null, 2)', detail: 'JSON.stringify' },
      { label: 'jsonp', insertText: 'JSON.parse(${1:string})', detail: 'JSON.parse' },
    ],
  },

  typescript: {
    keywords: [
      'const', 'let', 'var', 'function', 'class', 'interface', 'type', 'enum', 'namespace',
      'import', 'export', 'default', 'from', 'return', 'if', 'else', 'while', 'for', 'of', 'in',
      'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'new', 'this',
      'super', 'extends', 'implements', 'async', 'await', 'yield', 'typeof', 'instanceof',
      'as', 'is', 'keyof', 'readonly', 'public', 'private', 'protected', 'abstract',
    ],
    builtins: [
      'string', 'number', 'boolean', 'any', 'unknown', 'never', 'void', 'null', 'undefined',
      'Promise', 'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit', 'Array', 'Map', 'Set',
    ],
    snippets: [
      { label: 'interface', insertText: 'interface ${1:Name} {\n\t${2:field}: ${3:string};\n}', detail: 'Interface definition' },
      { label: 'type', insertText: 'type ${1:Name} = ${2:string};', detail: 'Type alias' },
      { label: 'enum', insertText: 'enum ${1:Name} {\n\t${2:First},\n}', detail: 'Enum definition' },
      { label: 'log', insertText: 'console.log(${1:item});', detail: 'console.log' },
      { label: 'fn', insertText: 'function ${1:name}(${2:params}): ${3:void} {\n\t${4}\n}', detail: 'Typed function' },
      { label: 'afn', insertText: 'async function ${1:name}(${2:params}): Promise<${3:void}> {\n\t${4}\n}', detail: 'Typed async function' },
      { label: 'arrow', insertText: 'const ${1:name} = (${2:params}): ${3:void} => {\n\t${4}\n};', detail: 'Typed arrow function' },
      { label: 'imp', insertText: "import { ${1:name} } from '${2:module}';", detail: 'Named import' },
      { label: 'try', insertText: 'try {\n\t${1}\n} catch (err) {\n\t${2:console.error(err);}\n}', detail: 'Try-catch block' },
    ],
  },

  cpp: {
    keywords: [
      'int', 'float', 'double', 'char', 'bool', 'void', 'auto', 'const', 'constexpr', 'struct',
      'class', 'enum', 'namespace', 'using', 'template', 'typename', 'public', 'private',
      'protected', 'virtual', 'override', 'static', 'inline', 'return', 'if', 'else', 'for',
      'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'sizeof', 'nullptr',
      'new', 'delete', 'try', 'catch', 'throw', 'std', 'vector', 'string', 'map', 'unique_ptr',
      'shared_ptr', 'cout', 'cin', 'endl',
    ],
    builtins: [
      'std::cout', 'std::cin', 'std::endl', 'std::vector', 'std::string', 'std::map',
      'std::make_unique', 'std::make_shared', 'printf', 'scanf', 'malloc', 'free', 'size_t',
    ],
    snippets: [
      { label: 'inc', insertText: '#include <${1:iostream}>', detail: 'System include' },
      { label: 'incl', insertText: '#include "${1:header.h}"', detail: 'Local include' },
      { label: 'main', insertText: 'int main(int argc, char *argv[]) {\n\t${1}\n\treturn 0;\n}', detail: 'main function' },
      { label: 'cout', insertText: 'std::cout << ${1:"Hello, World!"} << std::endl;', detail: 'std::cout print' },
      { label: 'fori', insertText: 'for (size_t ${1:i} = 0; ${1:i} < ${2:count}; ++${1:i}) {\n\t${3}\n}', detail: 'Indexed for loop' },
      { label: 'forauto', insertText: 'for (const auto &${1:item} : ${2:container}) {\n\t${3}\n}', detail: 'Range-for loop' },
      { label: 'class', insertText: 'class ${1:ClassName} {\npublic:\n\t${1:ClassName}();\n\tvirtual ~${1:ClassName}();\nprivate:\n\t${2}\n};', detail: 'Class definition' },
      { label: 'struct', insertText: 'struct ${1:Name} {\n\t${2}\n};', detail: 'Struct definition' },
      { label: 'template', insertText: 'template <typename ${1:T}>', detail: 'Template declaration' },
    ],
  },

  c: {
    keywords: [
      'int', 'float', 'double', 'char', 'void', 'const', 'struct', 'enum', 'union', 'typedef',
      'static', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
      'break', 'continue', 'sizeof', 'NULL',
    ],
    builtins: ['printf', 'scanf', 'malloc', 'free', 'calloc', 'realloc', 'memcpy', 'memset', 'strlen', 'size_t'],
    snippets: [
      { label: 'inc', insertText: '#include <${1:stdio.h}>', detail: 'System header' },
      { label: 'incl', insertText: '#include "${1:header.h}"', detail: 'Local header' },
      { label: 'main', insertText: 'int main(int argc, char *argv[]) {\n\t${1}\n\treturn 0;\n}', detail: 'main function' },
      { label: 'prf', insertText: 'printf("${1:%s\\n}", ${2:args});', detail: 'printf' },
      { label: 'fori', insertText: 'for (int ${1:i} = 0; ${1:i} < ${2:count}; ${1:i}++) {\n\t${3}\n}', detail: 'For loop' },
      { label: 'struct', insertText: 'typedef struct {\n\t${2:int field};\n} ${1:Name};', detail: 'typedef struct' },
    ],
  },

  go: {
    keywords: [
      'func', 'package', 'import', 'type', 'struct', 'interface', 'var', 'const', 'return',
      'if', 'else', 'for', 'range', 'switch', 'case', 'default', 'select', 'go', 'defer',
      'chan', 'map', 'make', 'new', 'append', 'len', 'cap', 'delete', 'close', 'panic',
      'recover', 'nil', 'true', 'false',
    ],
    builtins: [
      'string', 'int', 'int64', 'uint', 'float64', 'bool', 'byte', 'rune', 'error',
      'fmt.Println', 'fmt.Printf', 'fmt.Sprintf',
    ],
    snippets: [
      { label: 'main', insertText: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("${1:Hello, World!}")\n}', detail: 'Main package template' },
      { label: 'fn', insertText: 'func ${1:name}(${2:params}) ${3:error} {\n\t${4:return nil}\n}', detail: 'Function definition' },
      { label: 'iferr', insertText: 'if err != nil {\n\treturn ${1:err}\n}', detail: 'Error check idiom' },
      { label: 'struct', insertText: 'type ${1:Name} struct {\n\t${2:Field} ${3:string}\n}', detail: 'Struct definition' },
      { label: 'interface', insertText: 'type ${1:Name} interface {\n\t${2:Method() error}\n}', detail: 'Interface definition' },
      { label: 'forr', insertText: 'for ${1:i}, ${2:v} := range ${3:items} {\n\t${4}\n}', detail: 'For range loop' },
      { label: 'pln', insertText: 'fmt.Println(${1:args})', detail: 'fmt.Println' },
      { label: 'prf', insertText: 'fmt.Printf("${1:%v\\n}", ${2:args})', detail: 'fmt.Printf' },
    ],
  },

  html: {
    keywords: ['div', 'span', 'p', 'a', 'button', 'input', 'form', 'header', 'nav', 'main', 'section', 'footer', 'table', 'tr', 'td', 'th', 'ul', 'ol', 'li'],
    builtins: ['class', 'id', 'href', 'src', 'alt', 'type', 'value', 'placeholder', 'title', 'target', 'style', 'rel'],
    snippets: [
      { label: 'html5', insertText: '<!DOCTYPE html>\n<html lang="en">\n<head>\n\t<meta charset="UTF-8">\n\t<meta name="viewport" content="width=device-width, initial-scale=1.0">\n\t<title>${1:Document}</title>\n</head>\n<body>\n\t${2}\n</body>\n</html>', detail: 'HTML5 skeleton' },
      { label: 'script', insertText: '<script type="module" src="${1:main.js}"></script>', detail: 'Module script tag' },
      { label: 'link', insertText: '<link rel="stylesheet" href="${1:style.css}">', detail: 'Stylesheet link' },
      { label: 'div', insertText: '<div class="${1:container}">\n\t${2}\n</div>', detail: 'Div container' },
      { label: 'button', insertText: '<button type="${1:button}" class="${2:btn}">${3:Click}</button>', detail: 'Button element' },
      { label: 'input', insertText: '<input type="${1:text}" placeholder="${2:Enter value}" />', detail: 'Input element' },
      { label: 'a', insertText: '<a href="${1:#}">${2:Link}</a>', detail: 'Anchor link' },
      { label: 'img', insertText: '<img src="${1:url}" alt="${2:image}" />', detail: 'Image element' },
    ],
  },

  css: {
    keywords: [
      'display', 'position', 'flex', 'grid', 'margin', 'padding', 'width', 'height', 'color',
      'background', 'background-color', 'border', 'border-radius', 'font-size', 'font-weight',
      'font-family', 'line-height', 'text-align', 'align-items', 'justify-content', 'gap',
      'overflow', 'z-index', 'cursor', 'transition', 'animation', 'transform', 'box-shadow',
    ],
    builtins: ['none', 'block', 'inline-block', 'flex', 'grid', 'relative', 'absolute', 'fixed', 'sticky', 'center', 'inherit', 'initial'],
    snippets: [
      { label: 'flex', insertText: 'display: flex;\njustify-content: ${1:center};\nalign-items: ${2:center};', detail: 'Flex centering' },
      { label: 'grid', insertText: 'display: grid;\ngrid-template-columns: ${1:repeat(auto-fit, minmax(200px, 1fr))};\ngap: ${2:16px};', detail: 'Responsive grid' },
      { label: 'media', insertText: '@media (max-width: ${1:768px}) {\n\t${2}\n}', detail: 'Media query' },
      { label: 'keyframes', insertText: '@keyframes ${1:name} {\n\t0% {\n\t\t${2}\n\t}\n\t100% {\n\t\t${3}\n\t}\n}', detail: 'CSS keyframes' },
      { label: 'trans', insertText: 'transition: all ${1:0.2s} ease;', detail: 'Transition property' },
      { label: 'shadow', insertText: 'box-shadow: 0 ${1:2px} ${2:8px} rgba(0, 0, 0, ${3:0.15});', detail: 'Box shadow' },
      { label: 'radius', insertText: 'border-radius: ${1:8px};', detail: 'Border radius' },
    ],
  },

  shell: {
    keywords: ['if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'case', 'esac', 'function', 'return', 'exit', 'export', 'source'],
    builtins: ['echo', 'cat', 'grep', 'awk', 'sed', 'chmod', 'chown', 'mkdir', 'rm', 'cp', 'mv', 'curl', 'wget', 'find', 'xargs'],
    snippets: [
      { label: 'shebang', insertText: '#!/usr/bin/env bash\nset -euo pipefail\n\n${1}', detail: 'Bash strict shebang' },
      { label: 'if', insertText: 'if [ ${1:condition} ]; then\n\t${2}\nfi', detail: 'If statement' },
      { label: 'for', insertText: 'for ${1:item} in ${2:list}; do\n\t${3}\ndone', detail: 'For loop' },
      { label: 'while', insertText: 'while [ ${1:condition} ]; do\n\t${2}\ndone', detail: 'While loop' },
      { label: 'func', insertText: '${1:name}() {\n\t${2}\n}', detail: 'Function definition' },
      { label: 'case', insertText: 'case "${1:var}" in\n\t${2:pattern})\n\t\t${3};;\n\t*)\n\t\t${4};;\nesac', detail: 'Case statement' },
    ],
  },

  markdown: {
    keywords: [],
    builtins: [],
    snippets: [
      { label: 'link', insertText: '[${1:text}](${2:url})', detail: 'Markdown link' },
      { label: 'img', insertText: '![${1:alt}](${2:path})', detail: 'Markdown image' },
      { label: 'code', insertText: '```${1:language}\n${2}\n```', detail: 'Code fence block' },
      { label: 'table', insertText: '| ${1:Header 1} | ${2:Header 2} |\n| --- | --- |\n| ${3:Value 1} | ${4:Value 2} |', detail: 'Markdown table' },
      { label: 'todo', insertText: '- [ ] ${1:Task}', detail: 'Checklist item' },
    ],
  },

  sql: {
    keywords: [
      'SELECT', 'FROM', 'WHERE', 'INSERT INTO', 'UPDATE', 'DELETE', 'JOIN', 'INNER JOIN',
      'LEFT JOIN', 'RIGHT JOIN', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'CREATE TABLE',
      'ALTER TABLE', 'DROP TABLE', 'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES', 'INDEX', 'VIEW',
      'DISTINCT', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS NULL', 'IS NOT NULL', 'IN', 'BETWEEN',
      'LIKE', 'UNION', 'ALL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
    ],
    builtins: ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NOW', 'DATE', 'CONCAT'],
    snippets: [
      { label: 'select', insertText: 'SELECT ${1:*} FROM ${2:table} WHERE ${3:condition};', detail: 'SELECT query' },
      { label: 'insert', insertText: 'INSERT INTO ${1:table} (${2:columns}) VALUES (${3:values});', detail: 'INSERT statement' },
      { label: 'update', insertText: 'UPDATE ${1:table} SET ${2:column} = ${3:value} WHERE ${4:condition};', detail: 'UPDATE statement' },
      { label: 'delete', insertText: 'DELETE FROM ${1:table} WHERE ${2:condition};', detail: 'DELETE statement' },
      { label: 'ctable', insertText: 'CREATE TABLE ${1:table} (\n\t${2:id} SERIAL PRIMARY KEY,\n\t${3:name} VARCHAR(255) NOT NULL\n);', detail: 'CREATE TABLE' },
    ],
  },
};

// Aliases for matching Monaco language IDs
LANGUAGE_DATA.scss = LANGUAGE_DATA.css;
LANGUAGE_DATA.less = LANGUAGE_DATA.css;
LANGUAGE_DATA.mysql = LANGUAGE_DATA.sql;
LANGUAGE_DATA.pgsql = LANGUAGE_DATA.sql;

function registerLanguageSnippets(monaco) {
  for (const [langId, data] of Object.entries(LANGUAGE_DATA)) {
    monaco.languages.registerCompletionItemProvider(langId, {
      triggerCharacters: ['.', ':', '>', '<', '$', '@', '#', '_'],
      provideCompletionItems(model, position) {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };

        const suggestions = [];

        // 1. Snippets
        if (data.snippets) {
          for (const s of data.snippets) {
            suggestions.push({
              label: s.label,
              kind: monaco.languages.CompletionItemKind.Snippet,
              documentation: s.detail || s.label,
              detail: `(snippet) ${s.detail || ''}`,
              insertText: s.insertText,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              range,
              sortText: '0_' + s.label,
            });
          }
        }

        // 2. Keywords
        if (data.keywords) {
          for (const kw of data.keywords) {
            suggestions.push({
              label: kw,
              kind: monaco.languages.CompletionItemKind.Keyword,
              detail: 'keyword',
              insertText: kw,
              range,
              sortText: '1_' + kw,
            });
          }
        }

        // 3. Built-ins
        if (data.builtins) {
          for (const b of data.builtins) {
            suggestions.push({
              label: b,
              kind: monaco.languages.CompletionItemKind.Function,
              detail: 'standard library',
              insertText: b,
              range,
              sortText: '2_' + b,
            });
          }
        }

        return { suggestions };
      },
    });
  }
}

// ── File Path Autocompletion inside Quotes ──

function registerPathCompletion(monaco, context) {
  // Register for all languages so paths work in JS imports, Python open(), HTML src, etc.
  monaco.languages.registerCompletionItemProvider('*', {
    triggerCharacters: ['/', '.', '"', "'", '`'],
    async provideCompletionItems(model, position) {
      const lineUntilCursor = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      // Match if we are inside quotes: '...', "...", `...`
      const quoteMatch = lineUntilCursor.match(/(['"`])([^'"`]*)$/);
      if (!quoteMatch) return { suggestions: [] };

      const typedPath = quoteMatch[2];

      // Only offer path suggestions if typing starts with `./`, `../`, `/`, or has `/`
      if (!typedPath.startsWith('.') && !typedPath.includes('/')) {
        return { suggestions: [] };
      }

      const activePath = context.getActivePath();
      const rootPath = context.getRootPath();
      if (!activePath && !rootPath) return { suggestions: [] };

      // Determine the directory to look up
      const currentDir = activePath ? api.dirname(activePath) : rootPath;
      const lastSlash = typedPath.lastIndexOf('/');
      const dirPart = lastSlash === -1 ? '' : typedPath.slice(0, lastSlash);
      const filePrefix = lastSlash === -1 ? typedPath : typedPath.slice(lastSlash + 1);

      let targetDir;
      if (typedPath.startsWith('/')) {
        targetDir = rootPath ? api.join(rootPath, dirPart) : dirPart;
      } else if (dirPart) {
        targetDir = api.join(currentDir, dirPart);
      } else {
        targetDir = currentDir;
      }

      let listing;
      try {
        listing = await api.listDir(targetDir);
      } catch {
        return { suggestions: [] };
      }

      // Compute range for replacing the current file prefix
      const quoteCharIndex = quoteMatch.index;
      const prefixStartCol = quoteCharIndex + 1 + (lastSlash + 1) + 1; // 1-based column

      const range = {
        startLineNumber: position.lineNumber,
        startColumn: prefixStartCol,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      };

      const suggestions = listing.entries
        .filter((entry) => !filePrefix || entry.name.toLowerCase().startsWith(filePrefix.toLowerCase()))
        .map((entry) => ({
          label: entry.name,
          kind: entry.is_dir
            ? monaco.languages.CompletionItemKind.Folder
            : monaco.languages.CompletionItemKind.File,
          detail: entry.is_dir ? 'Folder' : `${(entry.size / 1024).toFixed(1)} KB`,
          insertText: entry.is_dir ? entry.name + '/' : entry.name,
          range,
          command: entry.is_dir ? { id: 'editor.action.triggerSuggest', title: 'Suggest' } : undefined,
          sortText: (entry.is_dir ? '0_' : '1_') + entry.name,
        }));

      return { suggestions };
    },
  });
}
