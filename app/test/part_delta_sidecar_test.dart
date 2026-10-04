import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/chat_provider.dart';

/// Part-delta sidecar semantics for non-claude CLIs (web
/// chat-event-controller.js handlePartDelta parity):
///  · reasoning → one Thinking card per session keyed
///    `sidecar-reasoning-<sessionId>`, text accumulated into {text:…},
///    startedAt at the first frame and endedAt settled when reasoning stops
///    (so think time is measured and lands in the wall-clock trajectory);
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
      // 没给时钟（now 缺省 0）时不写 epoch 0：宁可不计时，也不伪造。
      expect(tc.startedAt, isNull);
    });

    test('stamps a real startedAt when the caller supplies a clock', () {
      final msg = ChatMessage(role: MessageRole.assistant);
      applyReasoningDelta(msg, 'sess-1', '先分析', now: 1700000000000);

      expect(msg.toolCalls.single.startedAt, 1700000000000);
      // 只打了起点、还没结算 → 时长仍是未知，不编造。
      expect(msg.toolCalls.single.durationMs, isNull);
    });
  });

  group('settleThinkingCalls', () {
    test('closes an open Thinking span so think time becomes measurable', () {
      final msg = ChatMessage(role: MessageRole.assistant);
      applyReasoningDelta(msg, 'sess-1', '推理中', now: 1000);
      applyReasoningDelta(msg, 'sess-1', '…继续', now: 2000);

      final settled = settleThinkingCalls(msg, now: 5500);

      expect(settled, isTrue);
      expect(msg.toolCalls.single.durationMs, 4500);
    });

    test('is idempotent and never invents a span for an unstarted card', () {
      final msg = ChatMessage(role: MessageRole.assistant);
      // 无 startedAt 的老历史卡：不结算、不伪造。
      applyReasoningDelta(msg, 'sess-1', '老历史');
      expect(settleThinkingCalls(msg, now: 9000), isFalse);
      expect(msg.toolCalls.single.durationMs, isNull);

      applyReasoningDelta(msg, 'sess-2', '新推理', now: 10);
      expect(settleThinkingCalls(msg, now: 20), isTrue);
      // 再结算一次不动已完成的卡。
      expect(settleThinkingCalls(msg, now: 99), isFalse);
      expect(toolCallById(msg, 'sidecar-reasoning-sess-2')?.durationMs, 10);
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
