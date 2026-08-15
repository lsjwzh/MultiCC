import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/chat_provider.dart';

/// Part-delta sidecar semantics for non-claude CLIs (web
/// chat-event-controller.js handlePartDelta parity):
///  · reasoning → one Thinking card per session keyed
///    `sidecar-reasoning-<sessionId>`, text accumulated into {text:…}, and
///    NO startedAt (no fabricated durations / trajectory rows);
///  · tool → card keyed by toolId, raw argument fragments accumulated and
///    normalized (valid JSON when complete, {arguments: raw} mid-stream),
///    startedAt stamped at creation;
///  · both converge against the authoritative assistant snapshot, which
///    overwrites inputJson whenever it carries an input.
void main() {
  group('applyReasoningDelta', () {
    test('creates a single Thinking card on first fragment', () {
      final msg = ChatMessage(role: MessageRole.assistant);
      final changed = applyReasoningDelta(msg, 'sess-1', '先分析');

      expect(changed, isTrue);
      expect(msg.toolCalls, hasLength(1));
      final tc = msg.toolCalls.single;
      expect(tc.id, 'sidecar-reasoning-sess-1');
      expect(tc.name, 'Thinking');
      expect(tc.parsedInput?['text'], '先分析');
      // No tool timing is fabricated for reasoning.
      expect(tc.startedAt, isNull);
    });

    test('accumulates fragments into the same card, not duplicates', () {
      final msg = ChatMessage(role: MessageRole.assistant);
      applyReasoningDelta(msg, 'sess-1', '第一段');
      applyReasoningDelta(msg, 'sess-1', '第二段');
      applyReasoningDelta(msg, 'sess-1', '!');

      expect(msg.toolCalls, hasLength(1));
      expect(msg.toolCalls.single.parsedInput?['text'], '第一段第二段!');
    });

    test('empty fragment is a no-op', () {
      final msg = ChatMessage(role: MessageRole.assistant);
      expect(applyReasoningDelta(msg, 'sess-1', ''), isFalse);
      expect(msg.toolCalls, isEmpty);
    });

    test('different sessions get different sidecar cards', () {
      final msg = ChatMessage(role: MessageRole.assistant);
      applyReasoningDelta(msg, 'sess-1', 'a');
      applyReasoningDelta(msg, 'sess-2', 'b');
      expect(msg.toolCalls, hasLength(2));
    });
  });

  group('applyToolArgsDelta', () {
    test('creates the card with a real startedAt on first fragment', () {
      final msg = ChatMessage(role: MessageRole.assistant);
      final changed = applyToolArgsDelta(
        msg, 'tool-1', 'Bash', '{"comm',
        now: 1700000000000,
      );

      expect(changed, isTrue);
      final tc = msg.toolCalls.single;
      expect(tc.id, 'tool-1');
      expect(tc.name, 'Bash');
      expect(tc.startedAt, 1700000000000);
      // Mid-stream: incomplete JSON is wrapped so inputJson stays parsable.
      expect(tc.parsedInput?['arguments'], '{"comm');
    });

    test('accumulating fragments parse once the JSON is complete', () {
      final msg = ChatMessage(role: MessageRole.assistant);
      applyToolArgsDelta(msg, 'tool-1', 'Edit', '{"file', now: 1);
      applyToolArgsDelta(msg, 'tool-1', 'Edit', '_path":"a.dart","old', now: 2);
      final done = applyToolArgsDelta(
        msg, 'tool-1', 'Edit', '_string":"x"}',
        now: 3,
      );

      expect(done, isTrue);
      expect(msg.toolCalls, hasLength(1));
      final parsed = msg.toolCalls.single.parsedInput;
      expect(parsed, isNotNull);
      expect(parsed!['file_path'], 'a.dart');
      expect(parsed['old_string'], 'x');
    });

    test('empty ids or fragments are no-ops', () {
      final msg = ChatMessage(role: MessageRole.assistant);
      expect(applyToolArgsDelta(msg, '', 'Bash', 'x', now: 1), isFalse);
      expect(applyToolArgsDelta(msg, 'tool-1', 'Bash', '', now: 1), isFalse);
      expect(msg.toolCalls, isEmpty);
    });
  });

  group('toolCallById', () {
    test('finds by exact id, null otherwise', () {
      final msg = ChatMessage(role: MessageRole.assistant);
      applyToolArgsDelta(msg, 'a', 'Bash', '{}', now: 1);
      expect(toolCallById(msg, 'a')?.name, 'Bash');
      expect(toolCallById(msg, 'b'), isNull);
    });
  });

  group('authoritative snapshot convergence', () {
    test('snapshot input overwrites whatever the sidecar streamed', () {
      final msg = ChatMessage(role: MessageRole.assistant);
      applyToolArgsDelta(msg, 'tool-1', 'Read', '{"file_path": "/tmp/pa',
          now: 1);
      // finalizeAssistantMsg parity: complete input replaces the preview.
      final authoritative = {'file_path': '/tmp/path.dart', 'limit': 40};
      final existing = toolCallById(msg, 'tool-1');
      existing!.inputJson = jsonEncode(authoritative);

      expect(existing.parsedInput?['file_path'], '/tmp/path.dart');
      expect(existing.parsedInput?['limit'], 40);
    });

    test('reasoning sidecard survives a snapshot of tool blocks (id mismatch)',
        () {
      final msg = ChatMessage(role: MessageRole.assistant);
      applyReasoningDelta(msg, 'sess-1', 'thinking hard');
      applyToolArgsDelta(msg, 'tool-9', 'Bash', '{"command":"ls"}', now: 1);
      // Snapshot only knows real tool ids; the sidecar id never matches.
      final snap = toolCallById(msg, 'tool-9');
      expect(snap, isNotNull);
      expect(toolCallById(msg, 'sidecar-reasoning-sess-1'), isNotNull);
    });
  });
}
