import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/task_chat_transport.dart';
import 'package:multicc_app/services/workspace_service.dart';

// A2-b (chat-view unification I8, App side): the task detail sheet's live tail
// is folded from task_run_stream envelopes by the SAME TranscriptLiveFolder
// the session chat uses — the mirror of the web chat-task-mode
// handleWorkspaceMessage. These tests pin the envelope boundary semantics:
// taskId filtering, cli learning BEFORE the first slot event (codex delta
// folding is engine-gated), run-id change boundaries, and the assistant
// unwrapping that ChatService does for session sockets.
TaskRunStreamEvent envelope({
  String taskId = 'task-1',
  String runId = 'run-1',
  String? cli,
  required List<Map<String, dynamic>> slotEvents,
}) =>
    TaskRunStreamEvent(
      taskId: taskId,
      runId: runId,
      cli: cli,
      slotEvents: slotEvents,
    );

void main() {
  test('workspace envelope parsing carries the slot record cli', () {
    final parsed = WorkspaceService.parseTaskRunStreamEnvelope({
      'type': 'task_run_stream',
      'taskId': 'task-1',
      'runId': 'run-9',
      'dirId': 'dir-1',
      'cli': 'codex',
      'slotEvent': {
        'type': 'assistant',
        'message': {
          'content': [
            {'type': 'text', 'text': 'x'},
          ],
        },
      },
    });
    expect(parsed, isNotNull);
    expect(parsed!.cli, 'codex');
    expect(parsed.slotEvents, hasLength(1));

    final noCli = WorkspaceService.parseTaskRunStreamEnvelope({
      'type': 'task_run_stream',
      'taskId': 'task-1',
      'runId': 'run-9',
      'slotEvents': [
        {'type': 'message_start'},
      ],
    });
    expect(noCli, isNotNull);
    expect(noCli!.cli, isNull);
  });

  test('envelopes for other tasks are ignored; empty envelopes do not fold', () {
    final messages = <ChatMessage>[];
    final transport = TaskChatTransport(taskId: 'task-1', messages: messages);

    final applied = transport.handleEnvelope(
      envelope(
        taskId: 'task-2',
        slotEvents: [
          {
            'type': 'content_block_delta',
            'index': 0,
            'delta': {'type': 'text_delta', 'text': '别的任务'},
          },
        ],
      ),
    );
    expect(applied, isFalse);
    expect(messages, isEmpty);

    final empty = transport.handleEnvelope(envelope(slotEvents: const []));
    expect(empty, isFalse);
    expect(messages, isEmpty);
  });

  test('claude default: part_delta is a no-op, content_block_delta streams', () {
    final messages = <ChatMessage>[];
    final transport = TaskChatTransport(taskId: 'task-1', messages: messages);

    transport.handleEnvelope(
      envelope(
        slotEvents: [
          {
            'type': 'part_delta',
            'delta': {'type': 'text', 'text': 'ignored'},
          },
        ],
      ),
    );
    expect(messages, isEmpty);

    transport.handleEnvelope(
      envelope(
        slotEvents: [
          {
            'type': 'content_block_delta',
            'index': 0,
            'delta': {'type': 'text_delta', 'text': '流式'},
          },
        ],
      ),
    );
    expect(messages.single.content, '流式');
    expect(messages.single.isStreaming, isTrue);
  });

  test('the envelope cli lands BEFORE its slot events: codex part_delta folds', () {
    final messages = <ChatMessage>[];
    final transport = TaskChatTransport(taskId: 'task-1', messages: messages);

    // One envelope carries both the cli stamp and codex deltas — the engine
    // must be learned before the first event is folded, or the text is lost.
    final applied = transport.handleEnvelope(
      envelope(
        cli: 'codex',
        slotEvents: [
          {
            'type': 'part_delta',
            'delta': {'type': 'text', 'text': '部分'},
          },
          {
            'type': 'part_delta',
            'delta': {'type': 'reasoning', 'text': '推理'},
          },
        ],
      ),
    );
    expect(applied, isTrue);
    expect(messages.single.content, '部分');
    final reasoning = messages.single.toolCalls.single;
    expect(reasoning.id, 'sidecar-reasoning-task-task-1');
    expect(jsonDecode(reasoning.inputJson)['text'], '推理');
  });

  test('assistant slot events unwrap their message like the session socket', () {
    final messages = <ChatMessage>[];
    final transport = TaskChatTransport(taskId: 'task-1', messages: messages);

    // The envelope mirrors the slot event byte-for-byte: {type:'assistant',
    // message:{content:[...]}} — the session ChatService unwraps msg.message
    // before folding; the transport must do the same.
    transport.handleEnvelope(
      envelope(
        cli: 'codex',
        slotEvents: [
          {
            'type': 'assistant',
            'message': {
              'content': [
                {'type': 'text', 'text': '增量一'},
              ],
            },
          },
          {
            'type': 'assistant',
            'message': {
              'content': [
                {
                  'type': 'tool_use',
                  'id': 't-1',
                  'name': 'Bash',
                  'input': {'cmd': 'ls'},
                },
              ],
            },
          },
        ],
      ),
    );
    expect(messages.single.content, '增量一');
    expect(messages.single.toolCalls.single.id, 't-1');
    expect(jsonDecode(messages.single.toolCalls.single.inputJson), {
      'cmd': 'ls',
    });
  });

  test('a run-id change settles the previous tail and fires the boundary hook', () {
    final messages = <ChatMessage>[];
    final boundaries = <String>[];
    final transport = TaskChatTransport(
      taskId: 'task-1',
      messages: messages,
      onRunBoundary: boundaries.add,
    );

    transport.handleEnvelope(
      envelope(
        runId: 'run-1',
        slotEvents: [
          {
            'type': 'content_block_delta',
            'index': 0,
            'delta': {'type': 'text_delta', 'text': '第一轮'},
          },
        ],
      ),
    );
    expect(messages.single.isStreaming, isTrue);

    transport.handleEnvelope(
      envelope(
        runId: 'run-2',
        slotEvents: [
          {
            'type': 'content_block_delta',
            'index': 0,
            'delta': {'type': 'text_delta', 'text': '第二轮'},
          },
        ],
      ),
    );
    expect(boundaries, ['run-1', 'run-2'],
        reason:
            'the first live run is a boundary too (web maybeLiveSeparator '
            'parity: lastRunId starts null), marking where the live tail begins');
    expect(transport.runCount, 2);
    expect(messages, hasLength(2));
    expect(messages.first.content, '第一轮');
    expect(messages.first.isStreaming, isFalse,
        reason: 'the previous run tail settles before the new run folds');
    expect(messages.last.content, '第二轮');

    // Same runId again: no boundary, no extra bubble.
    transport.handleEnvelope(
      envelope(
        runId: 'run-2',
        slotEvents: [
          {
            'type': 'content_block_delta',
            'index': 0,
            'delta': {'type': 'text_delta', 'text': '+'},
          },
        ],
      ),
    );
    expect(messages.last.content, '第二轮+');
    expect(boundaries, ['run-1', 'run-2'],
        reason: 'a repeated runId never re-fires the boundary');
  });

  test('result attaches usage and finishes the tail; tool lifecycle folds', () {
    final messages = <ChatMessage>[];
    final transport = TaskChatTransport(taskId: 'task-1', messages: messages);

    transport.handleEnvelope(
      envelope(
        slotEvents: [
          {'type': 'message_start'},
          {
            'type': 'content_block_start',
            'index': 1,
            'content_block': {'type': 'tool_use', 'id': 'tu-1', 'name': 'Read'},
          },
          {
            'type': 'user',
            'message': {
              'content': [
                {
                  'type': 'tool_result',
                  'tool_use_id': 'tu-1',
                  'content': [
                    {'text': 'ok'},
                  ],
                },
              ],
            },
          },
          {
            'type': 'result',
            'usage': {'input_tokens': 5, 'output_tokens': 3},
            'durationMs': 42,
          },
        ],
      ),
    );
    expect(messages.single.isStreaming, isFalse);
    expect(messages.single.toolCalls.single.isDone, isTrue);
    expect(messages.single.toolCalls.single.result, 'ok');
    expect(messages.single.usage!.inputTokens, 5);
    expect(messages.single.durationMs, 42);
    expect(transport.folder.currentMsg, isNull);
  });
}
