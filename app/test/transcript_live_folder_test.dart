import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/transcript_live_folder.dart';

// TranscriptLiveFolder is the shared live-event folding core (chat-view
// unification I8: one event vocabulary, one folder). These tests pin the
// exact semantics ChatProvider had before the extraction — claude vs codex
// delta channels, tool lifecycle, result attachment — so the delegation is a
// behaviour-preserving refactor, and the task sheet can drive the same folder
// from task_run_stream envelopes.
void main() {
  TranscriptLiveFolder folder({
    SessionCli cli = SessionCli.claude,
    List<ChatMessage>? messages,
    void Function()? onTurnStart,
  }) =>
      TranscriptLiveFolder(
        messages: messages ?? [],
        cliOf: () => cli,
        sessionIdOf: () => 'sess-1',
        onTurnStart: onTurnStart,
      );

  test('messageStart opens one streaming bubble per turn and bumps the turn hook once', () {
    var turns = 0;
    final f = folder(onTurnStart: () => turns++);
    f.messageStart();
    expect(f.messages, hasLength(1));
    expect(f.messages.single.isStreaming, isTrue);
    expect(f.currentMsg, same(f.messages.single));
    // A second messageStart reuses the same bubble — no second turn bump.
    f.messageStart();
    expect(f.messages, hasLength(1));
    expect(turns, 1);
  });

  test('claude engine: part_delta is ignored; content_block_delta streams text', () {
    final f = folder(cli: SessionCli.claude);
    f.partDelta({
      'delta': {'type': 'text', 'text': 'ignored'},
    });
    expect(f.messages, isEmpty);

    f.contentBlockDelta({
      'index': 0,
      'delta': {'type': 'text_delta', 'text': '你好'},
    });
    f.contentBlockDelta({
      'index': 0,
      'delta': {'type': 'text_delta', 'text': '世界'},
    });
    expect(f.messages.single.content, '你好世界');
    expect(f.messages.single.isStreaming, isTrue);
  });

  test('codex engine: part_delta streams text, reasoning into the sidecar, tool args accumulate', () {
    final f = folder(cli: SessionCli.codex);
    f.partDelta({
      'delta': {'type': 'text', 'text': '部分'},
    });
    expect(f.messages.single.content, '部分');

    f.partDelta({
      'delta': {'type': 'reasoning', 'text': '先想'},
    });
    f.partDelta({
      'delta': {'type': 'reasoning', 'text': '再想'},
    });
    final reasoning = f.messages.single.toolCalls.single;
    expect(reasoning.id, 'sidecar-reasoning-sess-1');
    expect(reasoning.name, 'Thinking');
    expect(jsonDecode(reasoning.inputJson)['text'], '先想再想');
    expect(reasoning.startedAt, isNull);

    f.partDelta({
      'delta': {
        'type': 'tool',
        'toolId': 'call-1',
        'tool': {'name': 'Bash', 'arguments': '{"cmd":"ls'},
      },
    });
    f.partDelta({
      'delta': {
        'type': 'tool',
        'toolId': 'call-1',
        'tool': {'name': 'Bash', 'arguments': ' -la"}'},
      },
    });
    final tool = f.messages.single.toolCalls.last;
    expect(tool.id, 'call-1');
    expect(tool.name, 'Bash');
    expect(jsonDecode(tool.inputJson), {'cmd': 'ls -la'});
    expect(tool.startedAt, isNotNull);
  });

  test('assistant snapshot: claude seeds only an empty bubble; codex appends and owns tool cards', () {
    final claude = folder(cli: SessionCli.claude);
    claude.messageStart();
    claude.assistantSnapshot({
      'content': [
        {'type': 'text', 'text': '第一块'},
      ],
    });
    expect(claude.currentMsg!.content, '第一块');
    // Non-snapshot blocks never overwrite existing claude text.
    claude.assistantSnapshot({
      'content': [
        {'type': 'text', 'text': '后续快照'},
      ],
    });
    expect(claude.currentMsg!.content, '第一块');
    // textSnapshot replaces wholesale.
    claude.assistantSnapshot({
      'textSnapshot': true,
      'content': [
        {'type': 'text', 'text': '权威全文'},
      ],
    });
    expect(claude.currentMsg!.content, '权威全文');

    final codex = folder(cli: SessionCli.codex);
    codex.assistantSnapshot({
      'content': [
        {'type': 'text', 'text': '增量一'},
      ],
    });
    codex.assistantSnapshot({
      'content': [
        {'type': 'text', 'text': '增量二'},
      ],
    });
    expect(codex.currentMsg!.content, '增量一增量二');
    // Tool blocks arrive complete here (no content_block_start on codex).
    codex.assistantSnapshot({
      'content': [
        {
          'type': 'tool_use',
          'id': 't-1',
          'name': 'Read',
          'input': {'path': 'a.dart'},
        },
      ],
    });
    expect(codex.currentMsg!.toolCalls.single.id, 't-1');
    expect(jsonDecode(codex.currentMsg!.toolCalls.single.inputJson), {
      'path': 'a.dart',
    });
    // The authoritative snapshot overwrites the streamed partial input.
    codex.assistantSnapshot({
      'content': [
        {
          'type': 'tool_use',
          'id': 't-1',
          'name': 'Read',
          'input': {'path': 'b.dart'},
        },
      ],
    });
    expect(codex.currentMsg!.toolCalls.single.inputJson, jsonEncode({'path': 'b.dart'}));
  });

  test('content_block_start opens a live tool; the paired tool_result finishes it', () {
    final f = folder();
    // Real streams open the turn first; content_block_start then reuses the
    // bubble (a fresh bubble wipes activeTools by design).
    f.messageStart();
    f.contentBlockStart({
      'index': 1,
      'content_block': {'type': 'tool_use', 'id': 'tu-1', 'name': 'Edit'},
    });
    expect(f.currentMsg!.toolCalls.single.startedAt, isNotNull);
    f.contentBlockDelta({
      'index': 1,
      'delta': {'type': 'input_json_delta', 'partial_json': '{"file":'},
    });
    f.contentBlockDelta({
      'index': 1,
      'delta': {'type': 'input_json_delta', 'partial_json': '"x.dart"}'},
    });
    expect(f.currentMsg!.toolCalls.single.inputJson, '{"file":"x.dart"}');

    f.userToolResult({
      'message': {
        'content': [
          {
            'type': 'tool_result',
            'tool_use_id': 'tu-1',
            'content': [
              {'text': 'done ok'},
            ],
          },
        ],
      },
    });
    final tool = f.currentMsg!.toolCalls.single;
    expect(tool.result, 'done ok');
    expect(tool.isDone, isTrue);
    expect(tool.isError, isFalse);
    expect(tool.endedAt, isNotNull);
  });

  test('result attaches usage + duration, finishStreaming settles the tail and keeps lastAssistantMsg', () {
    final f = folder();
    f.messageStart();
    f.contentBlockDelta({
      'index': 0,
      'delta': {'type': 'text_delta', 'text': '答复'},
    });
    f.attachResultUsage({
      'usage': {'input_tokens': 11, 'output_tokens': 7},
      'durationMs': 1234,
    });
    expect(f.currentMsg!.usage!.inputTokens, 11);
    expect(f.currentMsg!.durationMs, 1234);

    f.finishStreaming();
    expect(f.currentMsg, isNull);
    expect(f.lastAssistantMsg, isNotNull);
    expect(f.lastAssistantMsg!.isStreaming, isFalse);
    expect(f.activeTools, isEmpty);
  });

  test('resetTail drops the streaming state without touching history', () {
    final f = folder();
    f.messageStart();
    f.resetTail();
    expect(f.currentMsg, isNull);
    expect(f.activeTools, isEmpty);
    expect(f.messages, hasLength(1), reason: 'the bubble itself stays');
  });
}
