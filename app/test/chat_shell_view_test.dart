import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:multicc_app/services/chat_shell_view.dart';
import 'package:multicc_app/services/shell_history_merge.dart';
import 'package:multicc_app/models/message.dart';

ChatMessage message(String id, int ts, {bool streaming = false}) =>
    ChatMessage.fromHistory({
      'id': id,
      'ts': ts,
      'role': 'assistant',
      'content': id,
      'streaming': streaming,
    });

void main() {
  test(
    'overlapping opens share admission; transient failure remains retryable',
    () async {
      final view = ChatShellView('source');
      final opening = Completer<http.Response>();
      var opens = 0;
      Future<http.Response> request(String path, String? body) async {
        if (body != null) {
          opens++;
          return opening.future;
        }
        return http.Response('{"activeSessionId":"execution"}', 200);
      }

      final first = view.prepare(request), second = view.prepare(request);
      opening.complete(http.Response('{"id":"shell"}', 200));
      expect(await Future.wait([first, second]), ['execution', 'execution']);
      expect(opens, 1);
      expect(view.historyPath('execution'), '/api/task-shells/shell/history');
      final retry = ChatShellView('source');
      await expectLater(
        retry.prepare((_, __) async => http.Response('{}', 503)),
        throwsStateError,
      );
      expect(await retry.prepare(request), 'execution');
    },
  );

  test('source IDs survive replay and target per-message actions', () async {
    final view = ChatShellView('source');
    await view.prepare(
      (_, body) async => http.Response(
        jsonEncode(
          body == null ? {'activeSessionId': 'execution'} : {'id': 'shell'},
        ),
        200,
      ),
    );
    final live = view.event({'type': 'chat_msg_meta', 'id': 'm'}, 'execution');
    final replay = view.event({
      'type': 'chat_history',
      'messages': [live],
    }, 'execution');
    expect(replay['messages'][0]['id'], 'execution:m');
    expect(shellMessageOwner('source', live['id']), (
      sessionId: 'execution',
      messageId: 'm',
    ));
    expect(shellMessageOwner('source', 'legacy'), (
      sessionId: 'source',
      messageId: 'legacy',
    ));
  });

  test('late task attribution is composited onto the shell id', () async {
    // 归属是这一轮结束后才判定的，它按**执行会话**的消息 id 指认消息；而壳气泡
    // 的 id 是复合 id。两者在这里对上，否则引用块会因为认不出这条消息而丢掉归属。
    final view = ChatShellView('source');
    await view.prepare(
      (_, body) async => http.Response(
        jsonEncode(
          body == null ? {'activeSessionId': 'execution'} : {'id': 'shell'},
        ),
        200,
      ),
    );
    final event = view.event({
      'type': 'chat_history_annotation',
      'messages': [
        {
          'id': 'm',
          'turnId': 'turn_1',
          'taskId': 'tsk_1',
          'taskName': '完善登录页面',
          'auxRunId': null,
        },
      ],
    }, 'execution');
    final record = event['messages'][0] as Map;
    expect(record['id'], 'execution:m');
    expect(record['sourceSessionId'], 'execution');
    expect(record['sourceMessageId'], 'm');
    // 归属本身原样带过去，没被复合化动过。
    expect(record['taskId'], 'tsk_1');
    expect(record['taskName'], '完善登录页面');
  });

  test('annotation arriving before the shell opens stays on raw ids', () {
    // 壳还没开（或本源不支持壳）时事件原样放行：这时气泡的 id 也是裸 id，
    // 两边同样对得上。
    final view = ChatShellView('source');
    final event = view.event({
      'type': 'chat_history_annotation',
      'messages': [
        {'id': 'm', 'taskId': 'tsk_1'},
      ],
    }, 'execution');
    expect((event['messages'][0] as Map)['id'], 'm');
    expect((event['messages'][0] as Map)['sourceMessageId'], isNull);
  });

  test(
    'cursor switch and reconnect preserve earlier pages and replace live checkpoints',
    () {      final old = [
        message('source:old', 1),
        message('source:partial', 2),
        message('task:live', 3, streaming: true),
      ];
      final merged = mergeShellHistory(old, [
        message('task:live', 3),
        message('task:done', 4),
      ]);
      expect(merged.map((m) => m.id), [
        'source:old',
        'source:partial',
        'task:live',
        'task:done',
      ]);
      expect(merged.where((m) => m.isStreaming), isEmpty);
      final passive = mergeShellHistory(
        [...merged, message('active:live', 5, streaming: true)],
        [message('source:partial', 2)],
        sourceSessionId: 'source',
      );
      expect(passive.map((m) => m.id), [
        'source:old',
        'source:partial',
        'task:live',
        'task:done',
        'active:live',
      ]);
      expect(streamingAssistantTail(passive)?.id, 'active:live');
    },
  );
}
