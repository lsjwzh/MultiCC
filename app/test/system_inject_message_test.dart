import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/auto_commit.dart';
import 'package:multicc_app/services/message_quote.dart';
import 'package:multicc_app/widgets/message_bubble.dart';

/// 🔇 系统注入消息（服务端 `src/session/delivery.js` 的 SYSTEM_PREFIX）：后台任务
/// 完成、延迟条件已到、内置任务已中断…… 引擎把它们落成 role=user 的历史记录，
/// 但没人打过这些字。这里钉住三件事：识别（parseSystemInject）、渲染（压成一行
/// 系统卡、点开看全文），以及「它在用户消息语义里要被排除」（自动提交锚点、引用
/// 角色）—— Web 端的同一组不变量在 tests/test-chat-history-view.js 里。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => I18n.init('zh'));

  ChatMessage injected(String text, {String id = 'm-inj'}) => ChatMessage(
        id: id,
        role: MessageRole.user,
        content: text,
        timestamp: DateTime.fromMillisecondsSinceEpoch(1724000004000),
      );

  Widget host(Widget child) => MaterialApp(home: Scaffold(body: child));

  group('parseSystemInject 拆标题和正文', () {
    test('【…】标签当标题，其余是正文', () {
      final parts = parseSystemInject('🔇 【后台任务完成 ×2】\n任务「迁移数据库」已结束');
      expect(parts, isNotNull);
      expect(parts!.label, '后台任务完成 ×2');
      expect(parts.body, '任务「迁移数据库」已结束');
    });

    test('多行正文整段保留，换行不丢', () {
      final parts = parseSystemInject('🔇 【后台任务完成】\n第一行\n第二行\n\n第四行');
      expect(parts!.label, '后台任务完成');
      expect(parts.body, '第一行\n第二行\n\n第四行');
    });

    test('带标签但没有正文时正文为空（卡片就不画展开控件）', () {
      final parts = parseSystemInject('🔇 【延迟条件已到】');
      expect(parts!.label, '延迟条件已到');
      expect(parts.body, '');
    });

    test('不带标签的单行整行当标题 —— 引擎的「继续：…」「[后台进程检查] …」', () {
      final parts = parseSystemInject('🔇 继续：把刚才的改动提交掉');
      expect(parts!.label, '继续：把刚才的改动提交掉');
      expect(parts.body, '');
    });

    test('不带标签的多行 = 首行标题 + 其余正文', () {
      final parts = parseSystemInject('🔇 [后台进程检查] 还有 2 个\npid 1234\npid 5678');
      expect(parts!.label, '[后台进程检查] 还有 2 个');
      expect(parts.body, 'pid 1234\npid 5678');
    });

    test('不是注入消息（或只剩一个前缀）时返回 null', () {
      expect(parseSystemInject('把测试补上'), isNull);
      expect(parseSystemInject('看这里 🔇 只是个表情'), isNull); // 前缀不在开头
      expect(parseSystemInject('🔇'), isNull); // 空注入没有可画的东西
      expect(parseSystemInject('🔇   \n '), isNull);
      expect(parseSystemInject(''), isNull);
      expect(parseSystemInject(null), isNull);
    });
  });

  group('注入消息画成系统卡', () {
    testWidgets('折叠态只画标题行；点标题展开全文，再点收回', (tester) async {
      const body = '任务「迁移数据库」已完成\n共 3 次提交';
      await tester.pumpWidget(host(
        MessageBubble(message: injected('🔇 【后台任务完成 ×2】\n$body')),
      ));

      // 标题行：图标 + 标签 + 折叠箭头。
      expect(find.text('🔇'), findsOneWidget);
      expect(find.text('后台任务完成 ×2'), findsOneWidget);
      expect(find.byIcon(Icons.chevron_right), findsOneWidget);

      // 正文默认压成一行省略号，但文字确实在（长按复制拿到的是整条原文）。
      Text bodyOf() => tester.widget<Text>(find.text(body));
      expect(bodyOf().maxLines, 1);
      expect(bodyOf().overflow, TextOverflow.ellipsis);

      await tester.tap(find.text('后台任务完成 ×2'));
      await tester.pump();
      expect(bodyOf().maxLines, isNull);
      expect(bodyOf().overflow, TextOverflow.visible);
      expect(find.byIcon(Icons.expand_more), findsOneWidget);

      await tester.tap(find.text('后台任务完成 ×2'));
      await tester.pump();
      expect(bodyOf().maxLines, 1);
    });

    testWidgets('没有正文的注入不画箭头也不接点击', (tester) async {
      await tester.pumpWidget(host(
        MessageBubble(message: injected('🔇 继续：把刚才的改动提交掉')),
      ));
      expect(find.text('继续：把刚才的改动提交掉'), findsOneWidget);
      expect(find.byIcon(Icons.chevron_right), findsNothing);
      expect(find.byIcon(Icons.expand_more), findsNothing);

      await tester.tap(find.text('继续：把刚才的改动提交掉'));
      await tester.pump(); // 不该抛错，也不该冒出什么展开态
      expect(find.byIcon(Icons.expand_more), findsNothing);
    });

    testWidgets('注入卡不挂「本轮自动提交」勾选框', (tester) async {
      await tester.pumpWidget(host(
        MessageBubble(
          message: injected('🔇 【后台任务完成】\n任务已结束'),
          showAutoCommit: true,
          autoCommitChecked: true,
          onAutoCommitChanged: (_) {},
        ),
      ));
      expect(find.byType(Checkbox), findsNothing);
      expect(find.text(t('autoCommitPerMsg')), findsNothing);

      // 对照：真用户气泡在同样入参下是挂的。
      await tester.pumpWidget(host(
        MessageBubble(
          message: ChatMessage(
            id: 'm-1',
            role: MessageRole.user,
            content: '把测试补上',
            timestamp: DateTime.fromMillisecondsSinceEpoch(1724000004000),
          ),
          showAutoCommit: true,
          autoCommitChecked: true,
          onAutoCommitChanged: (_) {},
        ),
      ));
      expect(find.byType(Checkbox), findsOneWidget);
    });
  });

  group('注入消息不算用户说过的话', () {
    test('lastUserMessageId 跳过注入消息，只认真正人打的那条', () {
      final messages = [
        ChatMessage(id: 'm-1', role: MessageRole.user, content: '把测试补上'),
        ChatMessage(
          id: 'm-2',
          role: MessageRole.assistant,
          content: '好',
        ),
        injected('🔇 【后台任务完成】\n任务已结束', id: 'm-3'),
      ];
      expect(lastUserMessageId(messages), 'm-1');

      // 整段历史里只有注入消息时，没有「这一轮」可挂 —— 不能拿系统卡顶上。
      expect(lastUserMessageId([injected('🔇 继续：重试一次', id: 'm-4')]), isNull);
    });

    test('引用注入消息时 role 记成系统行', () {
      final quote = buildMessageQuote(injected('🔇 【延迟条件已到】\n继续执行计划'));
      // 引用头里报的 role 是「系统」那一条，不是「你」。
      expect(quote, contains(t('msgQuoteRoleSystem')));
      expect(quote, isNot(contains(t('msgQuoteRoleUser'))));
      // 被引用的正文照常带上（引用的是这条记录的内容，不是它的身份）。
      expect(quote, contains('继续执行计划'));
    });
  });
}
