import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/models/task_board.dart';
import 'package:multicc_app/widgets/message_bubble.dart';

// A1 (I-A1): the task transcript renders through the SAME bubble tree as the
// session chat — no second renderer. The projection chatMessageFromTask maps
// the unified messages DTO onto ChatMessage, and MessageBubble's server
// actions (delete/fork — session-history operations bound to ChatProvider)
// are disabled for transcript hosts so a long press offers copy only.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => I18n.init('zh'));

  test('chatMessageFromTask projects the transcript row onto the shared bubble model', () {
    final msg = chatMessageFromTask(
      const TaskMessage(
        sessionId: '',
        role: 'assistant',
        messageId: 'm-9',
        ts: 1724000004000,
        text: '部分输出',
        taskRunId: 'run-9',
        partial: true,
      ),
    );
    expect(msg.role, MessageRole.assistant);
    expect(msg.content, '部分输出');
    expect(msg.id, 'm-9');
    expect(msg.timestamp.millisecondsSinceEpoch, 1724000004000);
    expect(msg.isPartial, isTrue);
    expect(msg.isStreaming, isFalse);

    final user = chatMessageFromTask(
      const TaskMessage(sessionId: '', role: 'user', text: '继续', ts: 0),
    );
    expect(user.role, MessageRole.user);
    expect(user.id, isNull); // id-less rows stay unaddressable, never fabricated
    expect(user.isPartial, isFalse);
  });

  test('ChatMessage.fromHistory accepts the partial marker from the unified DTO', () {
    final msg = ChatMessage.fromHistory({
      'id': 'm-2',
      'role': 'assistant',
      'content': '半截回答',
      'ts': 1724000004000,
      'partial': true,
    });
    expect(msg.isPartial, isTrue);
    expect(msg.isStreaming, isFalse);
  });

  testWidgets('task rows render markdown and the interrupted marker via the shared bubble', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MessageBubble(
            enableServerActions: false,
            message: chatMessageFromTask(
              const TaskMessage(
                sessionId: '',
                role: 'assistant',
                messageId: 'm-9',
                ts: 1724000004000,
                text: '**加粗**输出',
                partial: true,
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('输出中断'), findsOneWidget);
    expect(find.textContaining('加粗'), findsOneWidget);
  });

  testWidgets('transcript hosts hide delete/fork; session hosts keep them', (
    tester,
  ) async {
    ChatMessage row({required bool withId}) => ChatMessage(
      role: MessageRole.assistant,
      content: '内容',
      id: withId ? 'm-1' : null,
    );

    // Drive the bubble's long-press handler directly: pixel-level gesture
    // simulation against the markdown body is font-metric flaky in the test
    // environment (the arena never resolves), while the contract under test
    // is what the sheet offers once the handler runs.
    Future<void> openSheet() async {
      final gd = tester.widget<GestureDetector>(
        find.descendant(
          of: find.byType(MessageBubble),
          matching: find.byType(GestureDetector),
        ),
      );
      gd.onLongPress!();
      await tester.pumpAndSettle();
    }

    // Transcript host: server actions disabled — copy only, even with an id.
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MessageBubble(
            enableServerActions: false,
            message: row(withId: true),
          ),
        ),
      ),
    );
    await openSheet();
    expect(find.text('复制内容'), findsOneWidget);
    expect(find.text('隐藏'), findsNothing);
    expect(find.text('从此处分叉会话'), findsNothing);
    await tester.tap(find.text('复制内容'));
    await tester.pumpAndSettle();

    // Session host (default): id-addressable message keeps delete + fork.
    await tester.pumpWidget(
      MaterialApp(home: Scaffold(body: MessageBubble(message: row(withId: true)))),
    );
    await openSheet();
    expect(find.text('复制内容'), findsOneWidget);
    expect(find.text('隐藏'), findsOneWidget);
    expect(find.text('从此处分叉会话'), findsOneWidget);
  });
}
