import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
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
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListView(children: [MessageBubble(message: message)]),
        ),
      ),
    );
  }

  testWidgets('usage line and timing line both render when both exist', (
    tester,
  ) async {
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
    expect(find.textContaining('♻读'), findsOneWidget);
    expect(find.textContaining('♻写'), findsOneWidget);
    expect(
      find.textContaining(RegExp(r'🕐 \d{2}:\d{2}:\d{2}')),
      findsOneWidget,
    );
    expect(find.textContaining(RegExp(r'⏱ \d')), findsOneWidget);
  });

  testWidgets('usage alone renders; timing alone renders (no cross hiding)', (
    tester,
  ) async {
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

  testWidgets('主 row always; 辅 row only for a separately routed sub model', (
    tester,
  ) async {
    Map<String, dynamic> history(String subProvider) => {
      'role': 'assistant',
      'content': 'x',
      'usage': {'input_tokens': 56, 'output_tokens': 5156},
      'roleUsage': {
        'main': {'inputTokens': 56, 'outputTokens': 5156, 'cacheRead': 2698338},
        'mainByProvider': [
          {'providerId': 'glm', 'model': 'glm-5'},
        ],
        'sub': {'inputTokens': 10, 'outputTokens': 900, 'cacheRead': 40000},
        'subByProvider': [
          {'providerId': subProvider, 'model': 'glm-5'},
        ],
      },
    };
    await pumpBubble(tester, message: ChatMessage.fromHistory(history('ds')));
    expect(find.text(t('usageRoleMain')), findsOneWidget);
    expect(find.text(t('usageRoleSub')), findsOneWidget);
    expect(find.textContaining('↑入'), findsNWidgets(2));
    expect(find.textContaining('2.70M'), findsOneWidget);

    await pumpBubble(tester, message: ChatMessage.fromHistory(history('glm')));
    expect(find.text(t('usageRoleSub')), findsNothing);
    expect(find.textContaining('↑入'), findsOneWidget);
    expect(find.textContaining('2.74M'), findsOneWidget);
  });

  testWidgets('long token counts on a narrow lane do not overflow the bubble', (
    tester,
  ) async {
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

  testWidgets('跨天消息时间带日期，当天仍只显示时分秒', (tester) async {
    final now = DateTime.now();
    await pumpBubble(
      tester,
      message: ChatMessage(
        role: MessageRole.assistant,
        content: 'old',
        timestamp: DateTime(now.year - 1, 2, 3, 4, 5, 6),
        durationMs: 1,
      ),
    );
    expect(find.text('🕐 ${now.year - 1}-02-03 04:05:06'), findsOneWidget);

    await pumpBubble(
      tester,
      message: ChatMessage(
        role: MessageRole.assistant,
        content: 'today',
        timestamp: DateTime(now.year, now.month, now.day, 7, 8, 9),
        durationMs: 1,
      ),
    );
    expect(find.text('🕐 07:08:09'), findsOneWidget);
  });
}
