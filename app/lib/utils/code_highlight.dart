// Self-contained fenced-code syntax highlighting for the chat renderer —
// the mobile counterpart of the web's highlight.js integration.
//
// No third-party package is available in this project's offline pub cache
// (flutter_highlight/highlight are absent), so this is a compact regex
// tokenizer covering the languages that actually appear in agent output.
// Safety contract:
//   · unknown language        → [highlightCode] returns null → plain rendering
//   · oversized block (>20k)  → null (streaming perf guard for long dumps)
//   · regex failure of any kind → null, never a crash mid-render
// The caller always keeps select/copy (Text.rich inside the selectable
// MarkdownBody) regardless of which path renders.

import 'package:flutter/material.dart';

enum CodeTokenKind { keyword, string, comment, number, builtin, attr }

/// GitHub-dark-derived palette matching the app's code surfaces
/// (tool cards use #070809/#14171c backgrounds).
const Map<CodeTokenKind, Color> codeTokenColors = {
  CodeTokenKind.keyword: Color(0xFFFF7B72), // red
  CodeTokenKind.string: Color(0xFFA5D6FF), // light blue
  CodeTokenKind.comment: Color(0xFF8B949E), // gray
  CodeTokenKind.number: Color(0xFF79C0FF), // blue
  CodeTokenKind.builtin: Color(0xFFD2A8FF), // purple
  CodeTokenKind.attr: Color(0xFF7EE787), // green
};

class CodeSpan {
  final String text;
  final CodeTokenKind? kind;
  const CodeSpan(this.text, this.kind);
}

/// Blocks larger than this fall back to plain monospace — highlighting a huge
/// dump on every stream rebuild costs more than it is worth.
const int kMaxHighlightChars = 20000;

const Map<String, String> _languageAliases = {
  'javascript': 'js', 'jsx': 'js', 'mjs': 'js', 'cjs': 'js',
  'typescript': 'ts', 'tsx': 'ts',
  'shell': 'bash', 'sh': 'bash', 'zsh': 'bash', 'console': 'bash', 'terminal': 'bash',
  'golang': 'go',
  'python3': 'python', 'py': 'python',
  'c++': 'cpp', 'cxx': 'cpp', 'cc': 'cpp',
  'html': 'html', 'xml': 'html',
  'yml': 'yaml',
  'plaintext': '', 'text': '', 'txt': '', '': '',
};

String _canonLanguage(String raw) {
  final lang = raw.trim().toLowerCase();
  return _languageAliases[lang] ?? lang;
}

class _LangSpec {
  final String name;
  final List<(CodeTokenKind, String)> patterns;
  final bool caseInsensitive;
  const _LangSpec(this.name, this.patterns, {this.caseInsensitive = false});
}

String _kw(List<String> words) => '\\b(?:${words.join('|')})\\b';

const _cFamilyKeywords = [
  'abstract', 'as', 'async', 'await', 'base', 'break', 'case', 'catch',
  'class', 'const', 'continue', 'default', 'defer', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'extern', 'final', 'finally', 'fn', 'for',
  'from', 'func', 'function', 'go', 'if', 'impl', 'implements', 'import',
  'in', 'instanceof', 'interface', 'is', 'let', 'match', 'mod', 'mut',
  'namespace', 'new', 'null', 'nullptr', 'operator', 'override', 'package',
  'private', 'protected', 'public', 'pub', 'raise', 'readonly', 'record',
  'return', 'sealed', 'static', 'struct', 'super', 'switch', 'template',
  'this', 'throw', 'throws', 'trait', 'try', 'type', 'typedef', 'typeof',
  'union', 'unsafe', 'use', 'var', 'virtual', 'void', 'when', 'where',
  'while', 'with', 'yield',
];

const _jsBuiltins = [
  'Array', 'Boolean', 'console', 'document', 'Error', 'fetch', 'globalThis',
  'Infinity', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'parseInt',
  'parseFloat', 'Promise', 'process', 'require', 'Set', 'String', 'Symbol',
  'window', 'undefined',
];

final Map<String, _LangSpec> _langs = _buildLangs();

Map<String, _LangSpec> _buildLangs() {
  final cComment = '(//[^\\n]*|/\\*[\\s\\S]*?\\*/)';
  final hashComment = '(#[^\\n]*)';
  final strings = '("""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\')';
  final numbers = '\\b(?:0[xX][0-9a-fA-F]+|\\d+\\.?\\d*(?:[eE][+-]?\\d+)?)\\b';

  final jsSpec = _LangSpec('js', [
    (CodeTokenKind.comment, cComment),
    (CodeTokenKind.string, strings),
    (CodeTokenKind.keyword, _kw(_cFamilyKeywords)),
    (CodeTokenKind.builtin, _kw(_jsBuiltins)),
    (CodeTokenKind.number, numbers),
  ]);

  final pySpec = _LangSpec('python', [
    (CodeTokenKind.comment, hashComment),
    (CodeTokenKind.string, strings),
    (CodeTokenKind.keyword, _kw([
      'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
      'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from',
      'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not',
      'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
      'True', 'False', 'None',
    ])),
    (CodeTokenKind.builtin, _kw([
      'print', 'len', 'range', 'open', 'self', 'str', 'int', 'float', 'list',
      'dict', 'set', 'tuple', 'type', 'isinstance', 'enumerate', 'zip',
    ])),
    (CodeTokenKind.number, numbers),
  ]);

  final bashSpec = _LangSpec('bash', [
    (CodeTokenKind.comment, hashComment),
    (CodeTokenKind.string, '"(?:\\\\.|[^"\\\\])*"|\'[^\']*\''),
    (CodeTokenKind.builtin, r'\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$[0-9@?#*!]'),
    (CodeTokenKind.keyword, _kw([
      'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while',
      'until', 'case', 'esac', 'function', 'select', 'time', 'return',
      'break', 'continue', 'local', 'export', 'readonly', 'declare',
      'set', 'unset', 'shift', 'exit', 'source', 'trap', 'eval', 'exec',
    ])),
    (CodeTokenKind.number, '\\b\\d+\\b'),
  ]);

  final jsonSpec = _LangSpec('json', [
    (CodeTokenKind.attr, '"(?:\\\\.|[^"\\\\])*"(?=\\s*:)'),
    (CodeTokenKind.string, '"(?:\\\\.|[^"\\\\])*"'),
    (CodeTokenKind.keyword, '\\b(?:true|false|null)\\b'),
    (CodeTokenKind.number, '-?\\b\\d+\\.?\\d*(?:[eE][+-]?\\d+)?\\b'),
  ]);

  final yamlSpec = _LangSpec('yaml', [
    (CodeTokenKind.comment, hashComment),
    (CodeTokenKind.attr, '^[ \\t-]*[A-Za-z_][\\w.-]*(?=\\s*:)'),
    (CodeTokenKind.string, '"(?:\\\\.|[^"\\\\])*"|\'[^\']*\''),
    (CodeTokenKind.keyword, '\\b(?:true|false|null|yes|no|on|off)\\b'),
    (CodeTokenKind.number, '\\b\\d+\\b'),
  ]);

  final dartSpec = _LangSpec('dart', [
    (CodeTokenKind.comment, cComment),
    (CodeTokenKind.string, strings),
    (CodeTokenKind.keyword, _kw([
      ..._cFamilyKeywords,
      'extension', 'late', 'required', 'sync', 'async*', 'yield*', 'factory',
      'mixin', 'covariant', 'dynamic', 'get', 'set', 'part', 'assert',
      'await', 'external', 'abstract', 'show', 'hide', 'of',
    ])),
    (CodeTokenKind.builtin, _kw([
      'int', 'double', 'String', 'bool', 'num', 'List', 'Map', 'Set',
      'Iterable', 'Future', 'Stream', 'print', 'Widget', 'BuildContext',
      'State', 'const', 'true', 'false', 'null',
    ])),
    (CodeTokenKind.number, numbers),
  ]);

  final sqlSpec = _LangSpec('sql', [
    (CodeTokenKind.comment, '--[^\\n]*|/\\*[\\s\\S]*?\\*/'),
    (CodeTokenKind.string, "'(?:''|[^'])*'|\"(?:\\\\.|[^\"\\\\])*\""),
    (CodeTokenKind.keyword, _kw([
      'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set',
      'delete', 'create', 'table', 'alter', 'drop', 'index', 'view', 'join',
      'left', 'right', 'inner', 'outer', 'full', 'on', 'as', 'and', 'or',
      'not', 'null', 'is', 'in', 'between', 'like', 'order', 'by', 'group',
      'having', 'limit', 'offset', 'distinct', 'union', 'all', 'case',
      'when', 'then', 'else', 'end', 'exists', 'primary', 'key', 'foreign',
      'references', 'default', 'unique', 'constraint', 'with', 'returning',
    ]), ),
    (CodeTokenKind.number, '\\b\\d+\\b'),
  ], caseInsensitive: true);

  final goSpec = _LangSpec('go', [
    (CodeTokenKind.comment, cComment),
    (CodeTokenKind.string, '`[^`]*`|"(?:\\\\.|[^"\\\\\\n])*"'),
    (CodeTokenKind.keyword, _kw([
      ..._cFamilyKeywords,
      'chan', 'select', 'range', 'defer', 'go', 'map', 'string', 'int',
      'int64', 'float64', 'bool', 'byte', 'rune', 'error', 'true', 'false',
      'nil', 'interface',
    ])),
    (CodeTokenKind.number, numbers),
  ]);

  final rustSpec = _LangSpec('rust', [
    (CodeTokenKind.comment, cComment),
    (CodeTokenKind.string, strings),
    (CodeTokenKind.keyword, _kw([
      ..._cFamilyKeywords,
      'crate', 'dyn', 'Self', 'self', 'let', 'loop', 'move', 'ref', 'impl',
      'Some', 'None', 'Ok', 'Err', 'true', 'false', 'u8', 'u16', 'u32',
      'u64', 'usize', 'i8', 'i16', 'i32', 'i64', 'isize', 'f32', 'f64',
      'str', 'String', 'Vec', 'Option', 'Result', 'Box',
    ])),
    (CodeTokenKind.number, numbers),
  ]);

  final htmlSpec = _LangSpec('html', [
    (CodeTokenKind.comment, '<!--[\\s\\S]*?-->'),
    (CodeTokenKind.keyword, '</?[A-Za-z][\\w:-]*'),
    (CodeTokenKind.string, '"(?:[^"]*)"|\'(?:[^\']*)\''),
    (CodeTokenKind.attr, '\\b[A-Za-z_:][\\w:.-]*(?==)'),
  ]);

  final cssSpec = _LangSpec('css', [
    (CodeTokenKind.comment, '/\\*[\\s\\S]*?\\*/'),
    (CodeTokenKind.string, '"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\''),
    (CodeTokenKind.attr, '[-a-zA-Z]+(?=\\s*:)'),
    (CodeTokenKind.number, '-?\\b\\d+\\.?\\d*(?:px|em|rem|vh|vw|%|s|ms)?\\b|#[0-9a-fA-F]{3,8}\\b'),
    (CodeTokenKind.keyword, '@[a-zA-Z-]+|![a-zA-Z-]+'),
  ]);

  return {
    'js': jsSpec,
    'ts': _LangSpec('ts', [
      ...jsSpec.patterns,
    ]),
    'python': pySpec,
    'bash': bashSpec,
    'json': jsonSpec,
    'yaml': yamlSpec,
    'dart': dartSpec,
    'sql': sqlSpec,
    'go': goSpec,
    'rust': rustSpec,
    'html': htmlSpec,
    'css': cssSpec,
    'c': _LangSpec('c', [
      (CodeTokenKind.comment, cComment),
      (CodeTokenKind.string, strings),
      (CodeTokenKind.keyword, _kw([
        ..._cFamilyKeywords, 'auto', 'inline', 'restrict', 'sizeof', 'struct',
        'union', 'switch', 'register', 'volatile', 'char', 'short', 'long',
        'unsigned', 'signed', 'float', 'double', 'int', 'void', 'typedef',
        'enum', 'NULL',
      ])),
      (CodeTokenKind.number, numbers),
    ]),
    'cpp': _LangSpec('cpp', [
      (CodeTokenKind.comment, cComment),
      (CodeTokenKind.string, strings),
      (CodeTokenKind.keyword, _kw([
        ..._cFamilyKeywords, 'auto', 'inline', 'constexpr', 'nullptr',
        'namespace', 'template', 'typename', 'using', 'virtual', 'override',
        'final', 'std', 'vector', 'string', 'map', 'set', 'unique_ptr',
        'shared_ptr', 'cout', 'cin', 'endl',
      ])),
      (CodeTokenKind.number, numbers),
    ]),
    'java': _LangSpec('java', [
      (CodeTokenKind.comment, cComment),
      (CodeTokenKind.string, strings),
      (CodeTokenKind.keyword, _kw([
        ..._cFamilyKeywords, 'synchronized', 'transient', 'volatile',
        'native', 'strictfp', 'extends', 'implements', 'interface',
        'String', 'Integer', 'Boolean', 'List', 'Map', 'System', 'out',
        'println', 'true', 'false', 'null',
      ])),
      (CodeTokenKind.number, numbers),
    ]),
  };
}

/// Whether [rawLanguage] is one we can tokenize (used by tests and to decide
/// whether to show a language chip).
bool isSupportedLanguage(String rawLanguage) =>
    _langs.containsKey(_canonLanguage(rawLanguage));

/// Tokenize [code] for syntax highlighting. Returns null — and the caller
/// falls back to plain monospace — when the language is unknown/unsupported,
/// the block is oversized, or tokenization fails. Never throws.
List<CodeSpan>? highlightCode(String code, String rawLanguage) {
  if (code.length > kMaxHighlightChars) return null;
  final spec = _langs[_canonLanguage(rawLanguage)];
  if (spec == null) return null;

  try {
    return _tokenize(code, spec);
  } catch (_) {
    return null;
  }
}

List<CodeSpan> _tokenize(String code, _LangSpec spec) {
  // One alternation with one NAMED group per pattern kind. Patterns may carry
  // their own (unnamed) capture groups, which would shift positional group
  // indexes — named groups make the kind lookup immune to that.
  final combined = RegExp(
    [
      for (var i = 0; i < spec.patterns.length; i++)
        '(?<p$i>${spec.patterns[i].$2})',
    ].join('|'),
    multiLine: true,
    caseSensitive: !spec.caseInsensitive,
  );
  final spans = <CodeSpan>[];
  var pos = 0;
  for (final m in combined.allMatches(code)) {
    if (m.start > pos) {
      spans.add(CodeSpan(code.substring(pos, m.start), null));
    }
    var kind = CodeTokenKind.keyword;
    for (var i = 0; i < spec.patterns.length; i++) {
      if (m.namedGroup('p$i') != null) {
        kind = spec.patterns[i].$1;
        break;
      }
    }
    spans.add(CodeSpan(m.group(0)!, kind));
    pos = m.end;
    if (m.end == m.start) break; // zero-width safety, never loop
  }
  if (pos < code.length) spans.add(CodeSpan(code.substring(pos), null));
  return spans;
}

/// Build a styled TextSpan tree from a token list (plain runs keep the base
/// code style so the caller controls font/size/color).
TextSpan buildHighlightedSpan(List<CodeSpan> spans, TextStyle baseStyle) {
  return TextSpan(
    style: baseStyle,
    children: [
      for (final s in spans)
        TextSpan(
          text: s.text,
          style: s.kind == null ? null : TextStyle(color: codeTokenColors[s.kind]),
        ),
    ],
  );
}
