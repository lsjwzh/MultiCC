import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/message_bubble.dart';
import 'package:shared_preferences/shared_preferences.dart';

// The task transcript renders through the SAME bubble tree as the session chat
// — no second renderer. MessageBubble's server actions (delete/fork —
// session-history operations bound to ChatProvider) are disabled for
// transcript hosts so a long press offers copy only.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => I18n.init('zh'));

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
    },
  );

  test('history and late attribution retain the server-owned task short code', () {
      final history = ChatMessage.fromHistory({
        'id': 'm-3',
        'role': 'assistant',
        'content': '完成',
        'taskId': 'tsk_3',
        'taskName': '同步消息归属',
        'taskShortCode': 'A1B2',
      });
      expect(history.taskShortCode, 'A1B2');

      final live = ChatMessage(role: MessageRole.user, content: '继续');
      live.applyAttribution({
        'taskId': 'tsk_4',
        'taskName': '新的消息任务',
        'taskShortCode': 'C3D4',
      });
      expect(live.taskShortCode, 'C3D4');
    },
  );

  testWidgets('user and assistant bubbles show the same subtle task tail', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Column(
            children: [
              MessageBubble(
                message: ChatMessage(
                  role: MessageRole.user,
                  content: '继续',
                  taskId: 'tsk_1',
                  taskName: '很长的任务名称用于验证省略规则',
                  taskShortCode: 'a1b2',
                ),
              ),
              MessageBubble(
                message: ChatMessage(
                  role: MessageRole.assistant,
                  content: '完成',
                  taskId: 'tsk_1',
                  taskName: '很长的任务名称用于验证省略规则',
                  taskShortCode: 'A1B2',
                ),
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.byKey(const ValueKey('message-task-tail')), findsNWidgets(2));
    expect(find.text('#A1B2 · 很长的任务名称用于验…'), findsNWidgets(2));
  });

  testWidgets('a task id alone never fabricates a display code', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MessageBubble(
            message: ChatMessage(
              role: MessageRole.user,
              content: '尚未归因',
              taskId: 'tsk_not_a_display_code',
              taskName: '待归因任务',
            ),
          ),
        ),
      ),
    );
    expect(find.byKey(const ValueKey('message-task-tail')), findsNothing);
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

  // 产出链接优化：agent 输出的本地文件链接（裸绝对路径或带 server origin）要
  // 解析成文件路径走 /api/download，而不是当成服务器路由 404。外站链接不动。
  test('localFileLinkPath resolves local file links, leaves remote URLs alone', () async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': '127.0.0.1:3000',
    });
    final settings = await SettingsService.getInstance();
    // 裸绝对路径（含 file://）。
    expect(localFileLinkPath('/Users/me/project/a.dart', settings), '/Users/me/project/a.dart');
    expect(localFileLinkPath('file:///tmp/x.png', settings), '/tmp/x.png');
    expect(localFileLinkPath('/tmp/x.png', settings), '/tmp/x.png');
    // 带 server origin：只有 origin 与配置的服务器一致才剥掉。
    expect(localFileLinkPath('http://127.0.0.1:3000/Users/me/b.dart', settings), '/Users/me/b.dart');
    // 外站 / 端口不符 / 非文件路径一律不当作本地文件。
    expect(localFileLinkPath('http://example.com/Users/x.dart', settings), isNull);
    expect(localFileLinkPath('http://127.0.0.1:9999/Users/y.dart', settings), isNull);
    expect(localFileLinkPath('/artifacts/abc/index.html', settings), isNull);
    expect(localFileLinkPath('https://127.0.0.1:3000/Users/z.dart', settings), isNull);
  });
}
