import 'dart:convert' show JsonEncoder;

import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/models/tool_input_view.dart';

// Mirrors the web fixture in tests/test-chat-history-view.js ("typed tool
// input renders by tool name" + "tool duration is shown only when start and
// settle are measured"). Same cases, same expected strings — a drift between
// the Dart mirror and the web renderer fails its own suite.

void main() {
  group('renderToolInput (mirrors web renderToolInput)', () {
    String inputFor(String name, Map<String, dynamic> input) =>
        renderToolInput(name, input);

    test('per-type shapes match the web byte-for-byte', () {
      expect(inputFor('Bash', {'command': 'ls -la'}), r'$ ls -la');
      expect(inputFor('Read', {'file_path': '/a/b.ts'}), '/a/b.ts');
      expect(
        inputFor('Read', {'file_path': '/a', 'offset': 10, 'limit': 5}),
        '/a\n(offset: 10, limit: 5)',
      );
      expect(
        inputFor('Grep', {'pattern': 'foo', 'path': 'src', 'include': '*.js'}),
        '/foo/  src --include=*.js',
      );
      expect(
        inputFor('Glob', {'pattern': '**/*.md', 'path': 'docs'}),
        '**/*.md\nin docs',
      );
      expect(
        inputFor('WebFetch', {'url': 'http://x', 'prompt': 'sum'}),
        'http://x\nsum',
      );
      expect(
        inputFor('Edit', {'file_path': '/a', 'old_string': 'x', 'new_string': 'y'}),
        '/a\n--- old\nx\n+++ new\ny',
      );
      expect(
        inputFor('Write', {'file_path': '/a', 'content': 'hi'}),
        '/a\nhi',
      );
      expect(
        inputFor('Agent', {'description': 'find bugs', 'prompt': 'go'}),
        'find bugs\ngo',
      );
    });

    test('MultiEdit renders one diff block per edit', () {
      final out = inputFor('MultiEdit', {
        'file_path': '/a',
        'edits': [
          {'old_string': 'x', 'new_string': 'y'},
          {'old_string': 'p', 'new_string': 'q'},
        ],
      });
      expect(
        out,
        '/a\n--- edit 1 old\nx\n+++ edit 1 new\ny'
        '\n--- edit 2 old\np\n+++ edit 2 new\nq',
      );
    });

    test('unknown tool name falls back to pretty JSON', () {
      expect(
        inputFor('MysteryTool', {'a': 1}),
        const JsonEncoder.withIndent('  ').convert({'a': 1}),
      );
    });

    test('markup in content stays text', () {
      expect(inputFor('Bash', {'command': '<b>hi</b>'}), r'$ <b>hi</b>');
      expect(
        inputFor('Write', {'file_path': '/a', 'content': '<img onerror=boom>'}),
        '/a\n<img onerror=boom>',
      );
    });

    test('null / unparsable input degrades, never throws', () {
      expect(renderToolInput('Bash', null), r'$ ');
      expect(renderToolInput(null, {'a': 1}).isNotEmpty, true);
    });
  });

  group('humanizeToolDuration (mirrors web humanizeDuration)', () {
    test('measured spans render as in the web', () {
      expect(humanizeToolDuration(0), '0ms');
      expect(humanizeToolDuration(120), '120ms');
      expect(humanizeToolDuration(1500), '1.5s');
      expect(humanizeToolDuration(9400), '9.4s');
      expect(humanizeToolDuration(12345), '12s');
      expect(humanizeToolDuration(75000), '1m 15s');
      expect(humanizeToolDuration(120000), '2m');
    });

    test('unmeasurable spans return empty — never fabricate 0ms', () {
      expect(humanizeToolDuration(null), '');
      expect(humanizeToolDuration(-5), '');
    });
  });

  group('ToolCall.durationMs provenance', () {
    ToolCall tool({int? s, int? e}) => ToolCall(
      id: 't',
      name: 'Bash',
      startedAt: s,
      endedAt: e,
      isDone: true,
    );

    test('measured when both stamps exist', () {
      expect(tool(s: 1000, e: 2500).durationMs, 1500);
    });

    test('unknown (null) when a stamp is missing', () {
      expect(tool(s: 1000).durationMs, isNull);
      expect(tool(e: 2500).durationMs, isNull);
      expect(tool().durationMs, isNull);
    });

    test('clock skew degrades to unknown, not a negative span', () {
      expect(tool(s: 9000, e: 1000).durationMs, isNull);
    });

    test('parsedInput now really parses (was a stub returning {})', () {
      final tc = ToolCall(
        id: 't',
        name: 'Bash',
        inputJson: '{"command":"pwd"}',
      );
      expect(tc.description, 'pwd');
    });
  });
}
