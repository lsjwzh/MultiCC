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

  test(
    'cursor switch and reconnect preserve earlier pages and replace live checkpoints',
    () {
      final old = [
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
