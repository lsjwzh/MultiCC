import 'package:flutter/foundation.dart';
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
    // 用户气泡（纯 Text）而不是 AI 正文：正文走 markdown，落成 `Text.rich`
    // （data 为空），测试里不好定位，而这条契约与角色无关。平台钉成 iOS，工具条
    // 的形态才是 App 里那一个。
    ChatMessage row({required bool withId}) => ChatMessage(
      role: MessageRole.user,
      content: '内容',
      id: withId ? 'm-1' : null,
    );

    /// 长按气泡，等菜单（系统的选择工具条）弹出来。
    ///
    /// 这里必须走真实手势：菜单是 `SelectionArea` 弹的，直接调回调会恰好漏掉
    /// 「长按有没有落到选择上」这半条链路 —— 而它正是这次改动本身。
    Future<void> openMenu() async {
      final gesture = await tester.startGesture(
        tester.getRect(find.text('内容')).center,
      );
      await tester.pump(const Duration(milliseconds: 700));
      await gesture.up();
      await tester.pumpAndSettle();
    }

    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    try {
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
      await openMenu();
      expect(find.text('复制内容'), findsOneWidget);
      expect(find.text('隐藏'), findsNothing);
      expect(find.text('从此处分叉会话'), findsNothing);
      await tester.tap(find.text('复制内容'));
      await tester.pumpAndSettle();

      // Session host (default): id-addressable message keeps delete + fork.
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: MessageBubble(message: row(withId: true))),
        ),
      );
      await openMenu();
      expect(find.text('复制内容'), findsOneWidget);
      expect(find.text('隐藏'), findsOneWidget);
      expect(find.text('从此处分叉会话'), findsOneWidget);
    } finally {
      // 必须写在测试体内：addTearDown 晚于 flutter_test 的 debug 变量不变量检查。
      debugDefaultTargetPlatformOverride = null;
    }
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
  // multicc-human-assist 直达链接：Web 原地展开屏幕浮层，App 路由到原生屏幕页。
  test('remoteScreenLinkMode routes #rs links to the native screen page', () async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': '127.0.0.1:3000',
    });
    final settings = await SettingsService.getInstance();
    expect(remoteScreenLinkMode('#rs=control', settings), 'control');
    expect(remoteScreenLinkMode('#rs=1', settings), '1');
    expect(remoteScreenLinkMode('/chat.html?air=1&task=t1&rs=control', settings), 'control');
    expect(remoteScreenLinkMode('/chat.html?air=1&task=t1#rs=1', settings), '1');
    expect(remoteScreenLinkMode('http://127.0.0.1:3000/chat.html?air=1&task=t1&rs=control', settings), 'control');
    // 非法值 / 外站 / 别的页面 / 普通锚点一律不拦，照常走浏览器。
    expect(remoteScreenLinkMode('#rs=2', settings), isNull);
    expect(remoteScreenLinkMode('#section-1', settings), isNull);
    expect(remoteScreenLinkMode('http://example.com/chat.html?rs=control', settings), isNull);
    expect(remoteScreenLinkMode('/artifacts/abc/index.html?rs=control', settings), isNull);
  });
}
