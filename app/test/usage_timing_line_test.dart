import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/widgets/message_bubble.dart';

void main() {
  // Narrow-phone lane: 320dp viewport, bubble maxWidth 92% => ~294dp.
  Future<void> pumpBubble(
    WidgetTester tester, {
    required ChatMessage message,
    double width = 320,
  }) async {
    tester.view.physicalSize = Size(width, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: ListView(children: [MessageBubble(message: message)]),
      ),
    ));
  }

  testWidgets('usage line and timing line both render when both exist',
      (tester) async {
    final message = ChatMessage(
      role: MessageRole.assistant,
      content: 'done',
      usage: MessageUsage(
        inputTokens: 9273,
        outputTokens: 1752,
        cacheReadTokens: 609536,
        cacheCreationTokens: 18432,
      ),
      durationMs: 71014,
    );
    await pumpBubble(tester, message: message);

    expect(find.textContaining('↑入'), findsOneWidget);
    expect(find.textContaining('↓出'), findsOneWidget);
    expect(find.textContaining('⏱读'), findsOneWidget);
    expect(find.textContaining('⏱写'), findsOneWidget);
    expect(find.textContaining(RegExp(r'🕐 \d{2}:\d{2}:\d{2}')), findsOneWidget);
    // The timing line's ⏱ duration and the cache badges' ⏱ glyph coexist.
    expect(find.textContaining(RegExp(r'⏱ \d')), findsOneWidget);
  });

  testWidgets('usage alone renders; timing alone renders (no cross hiding)',
      (tester) async {
    await pumpBubble(
      tester,
      message: ChatMessage(
        role: MessageRole.assistant,
        content: 'usage only',
        usage: MessageUsage(inputTokens: 1234, outputTokens: 56),
      ),
    );
    expect(find.textContaining('↑入'), findsOneWidget);
    expect(find.textContaining('🕐'), findsNothing);

    await pumpBubble(
      tester,
      message: ChatMessage(
        role: MessageRole.assistant,
        content: 'timing only',
        durationMs: 45000,
      ),
    );
    expect(find.textContaining('↑入'), findsNothing);
    expect(find.textContaining('⏱'), findsOneWidget);
  });

  testWidgets('long token counts on a narrow lane do not overflow the bubble',
      (tester) async {
    final message = ChatMessage(
      role: MessageRole.assistant,
      content: 'narrow',
      usage: MessageUsage(
        inputTokens: 1452302,
        outputTokens: 1109800,
        cacheReadTokens: 9876543,
        cacheCreationTokens: 7654321,
      ),
      durationMs: 771681,
    );
    await pumpBubble(tester, message: message, width: 320);

    expect(tester.takeException(), isNull);
  });
}
