import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/models/message.dart';

void main() {
  test('history keeps the server-authored context trace manifest', () {
    final message = ChatMessage.fromHistory({
      'role': 'assistant',
      'content': 'done',
      'contextTrace': {
        'traceId': 'sr-1',
        'currentTask': {'taskId': 'tsk-current'},
        'sources': [
          {'taskId': 'tsk-source', 'mode': 'refilled', 'messageCount': 2},
        ],
      },
    });

    expect(message.contextTrace?['traceId'], 'sr-1');
    expect((message.contextTrace?['sources'] as List).first['taskId'], 'tsk-source');
  });
}
