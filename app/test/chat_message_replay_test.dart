import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/models/message.dart';

void main() {
  test('reconnect history preserves the authoritative streaming tail', () {
    final messages = [
      ChatMessage.fromHistory({
        'id': 'assistant-live',
        'role': 'assistant',
        'content': 'first batch plus second batch',
        'streaming': true,
      }),
    ];

    final tail = streamingAssistantTail(messages);
    expect(tail, same(messages.single));
    expect(tail?.isStreaming, isTrue);
  });

  test('completed history is never adopted as a streaming tail', () {
    final messages = [
      ChatMessage.fromHistory({
        'id': 'assistant-final',
        'role': 'assistant',
        'content': 'done',
      }),
    ];

    expect(streamingAssistantTail(messages), isNull);
  });

  test('history keeps client correlation id for FIFO reconciliation', () {
    final message = ChatMessage.fromHistory({
      'id': 'user-1',
      'role': 'user',
      'content': 'queued',
      'clientMsgId': 'app-123',
    });

    expect(message.clientMsgId, 'app-123');
  });
}
