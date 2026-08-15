import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/utils/code_highlight.dart';

/// Fenced-code highlighting safety contract:
///  · supported languages tokenize into colored + plain spans;
///  · unknown language / oversize block / broken input → null → the caller
///    falls back to the default plain monospace block;
///  · the span text concatenates back to the source (no data loss);
///  · TextSpan tree builds for the selectable renderer.
void main() {
  test('js keywords, strings, comments and numbers are colored', () {
    final spans = highlightCode('''
// fetch the config
const x = "hello" + 42;
if (x) console.log(x);
''', 'js');

    expect(spans, isNotNull);
    final joined = spans!.map((s) => s.text).join();
    expect(joined, contains('const x = "hello" + 42;'));

    final kinds = spans.where((s) => s.kind != null).map((s) => s.kind);
    expect(kinds, contains(CodeTokenKind.comment));
    expect(kinds, contains(CodeTokenKind.string));
    expect(kinds, contains(CodeTokenKind.number));
    // `const` / `if` as keywords (or the combined word runs containing them).
    final keywordText = spans
        .where((s) => s.kind == CodeTokenKind.keyword)
        .map((s) => s.text)
        .join(' ');
    expect(keywordText, contains('const'));
    expect(keywordText, contains('if'));
  });

  test('round-trips every supported language without losing text', () {
    const samples = {
      'js': 'const a = 1;',
      'typescript': 'let b: string = "x";',
      'python': 'def main():\n    print("hi")\n',
      'py': 'import os\n',
      'bash': r'echo $HOME # done',
      'shell': r'for f in *; do echo $f; done',
      'json': '{"a": 1, "b": [true, null]}',
      'yaml': 'name: app\nitems:\n  - one\n',
      'dart': 'void main() => print(1);',
      'go': 'func main() { fmt.Println("x") }',
      'rust': 'fn main() { let s = String::from("x"); }',
      'sql': 'SELECT * FROM users WHERE id = 1;',
      'html': '<div class="a">hi</div>',
      'css': 'body { color: #fff; }',
      'c': 'int main() { return 0; }',
      'cpp': 'auto x = std::vector<int>{};',
      'java': 'class A { void run() {} }',
    };
    for (final entry in samples.entries) {
      final spans = highlightCode(entry.value, entry.key);
      expect(spans, isNotNull, reason: '${entry.key} should be supported');
      expect(
        spans!.map((s) => s.text).join(),
        entry.value,
        reason: '${entry.key} spans must round-trip the source',
      );
    }
  });

  test('json object keys are attr-colored, literals keyword-colored', () {
    final spans = highlightCode('{"k": true}', 'json');
    expect(spans, isNotNull);
    final kinds = spans!.where((s) => s.kind != null).map((s) => s.kind);
    expect(kinds, containsAll([CodeTokenKind.attr, CodeTokenKind.keyword]));
  });

  test('bash variables and comments are recognized', () {
    final spans = highlightCode('# note\nrm -rf \$TMPDIR/cache', 'bash');
    expect(spans, isNotNull);
    final joined = spans!.map((s) => s.text).join();
    expect(joined, contains('rm -rf \$TMPDIR/cache'));
    final kinds = spans.where((s) => s.kind != null).map((s) => s.kind);
    expect(kinds, contains(CodeTokenKind.comment));
    expect(kinds, contains(CodeTokenKind.builtin));
  });

  test('unknown language returns null (caller keeps plain rendering)', () {
    expect(highlightCode('whatever', 'brainfuck'), isNull);
    expect(highlightCode('whatever', ''), isNull);
    // Explicit plaintext aliases also opt out.
    expect(highlightCode('plain text here', 'plaintext'), isNull);
    expect(highlightCode('plain text here', 'text'), isNull);
  });

  test('isSupportedLanguage mirrors the tokenizer set + aliases', () {
    expect(isSupportedLanguage('JavaScript'), isTrue);
    expect(isSupportedLanguage('TSX'), isTrue);
    expect(isSupportedLanguage('golang'), isTrue);
    expect(isSupportedLanguage('c++'), isTrue);
    expect(isSupportedLanguage('txt'), isFalse);
    expect(isSupportedLanguage('klingon'), isFalse);
  });

  test('oversized block returns null instead of tokenizing', () {
    final huge = 'x = 1\n' * 4000; // > 20k chars
    expect(huge.length, greaterThan(kMaxHighlightChars));
    expect(highlightCode(huge, 'python'), isNull);
    final edge = 'x' * kMaxHighlightChars;
    expect(highlightCode(edge, 'python'), isNotNull);
  });

  test('no crash on pathological input', () {
    // Unterminated constructs, nested quotes, unicode, empty.
    expect(highlightCode('', 'js'), isNotNull);
    expect(highlightCode('"""', 'python'), isNotNull);
    expect(highlightCode('"\\', 'js'), isNotNull);
    expect(highlightCode('你好 \\u00e9 🎉', 'dart'), isNotNull);
    expect(highlightCode('/*', 'c'), isNotNull);
  });

  test('buildHighlightedSpan yields a TextSpan with colored children', () {
    final spans = highlightCode('const a = "s";', 'js')!;
    final span = buildHighlightedSpan(
      spans,
      const TextStyle(fontFamily: 'monospace', fontSize: 13),
    );
    expect(span, isA<TextSpan>());
    expect(span.children, isNotEmpty);
    final colored = span.children!
        .whereType<TextSpan>()
        .where((ts) => ts.style?.color != null);
    expect(colored, isNotEmpty);
    // Every colored child uses the palette.
    for (final ts in colored) {
      expect(codeTokenColors.values.contains(ts.style!.color), isTrue);
    }
  });
}
