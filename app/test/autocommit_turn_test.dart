import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/chat_provider.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/message_bubble.dart';

/// 每轮自动提交（web 的 `.msg-auto-commit` + `attachAutoCommitCheck`）：
/// 勾选框挂在最后一条用户消息下面，勾了的那一轮跑完自动 commit + merge。
/// 这里只管两件能在 widget/provider 层验证的事：气泡上那块 UI 的行为，
/// 以及 provider 里「这一轮勾没勾 / 提交过没有」的状态机。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => I18n.init('zh'));

  ChatMessage userMsg({String id = 'm-1', String text = '把测试补上'}) =>
      ChatMessage(
        id: id,
        role: MessageRole.user,
        content: text,
        timestamp: DateTime.fromMillisecondsSinceEpoch(1724000004000),
      );

  Widget host(Widget child) =>
      MaterialApp(home: Scaffold(body: child));

  group('每轮自动提交勾选框', () {
    testWidgets('默认不挂；showAutoCommit 时才出现，且默认勾选态跟随传入值', (tester) async {
      await tester.pumpWidget(host(MessageBubble(message: userMsg())));
      expect(find.byType(Checkbox), findsNothing);
      expect(find.text(t('autoCommitPerMsg')), findsNothing);

      await tester.pumpWidget(host(
        MessageBubble(
          message: userMsg(),
          showAutoCommit: true,
          autoCommitChecked: true,
          onAutoCommitChanged: (_) {},
        ),
      ));
      expect(find.byType(Checkbox), findsOneWidget);
      expect(find.text(t('autoCommitPerMsg')), findsOneWidget);
      expect(tester.widget<Checkbox>(find.byType(Checkbox)).value, isTrue);
    });

    testWidgets('点勾选框和点文字行都会回调取反后的值', (tester) async {
      final seen = <bool>[];
      await tester.pumpWidget(host(
        MessageBubble(
          message: userMsg(),
          showAutoCommit: true,
          autoCommitChecked: true,
          onAutoCommitChanged: seen.add,
        ),
      ));

      await tester.tap(find.byType(Checkbox));
      await tester.pump();
      expect(seen, [false]);

      // 文字行也是可点的（web 那边点 label 区域同样会 toggle）。
      await tester.tap(find.text(t('autoCommitPerMsg')));
      await tester.pump();
      expect(seen, [false, false]);
    });

    testWidgets('已提交过的一轮变成只读的「✓ 已提交」，点不动', (tester) async {
      var calls = 0;
      await tester.pumpWidget(host(
        MessageBubble(
          message: userMsg(),
          showAutoCommit: true,
          autoCommitChecked: true,
          autoCommitDone: true,
          onAutoCommitChanged: (_) => calls++,
        ),
      ));

      expect(
        find.text('${t('autoCommitPerMsg')} ${t('autoCommitPerMsgDone')}'),
        findsOneWidget,
      );
      expect(tester.widget<Checkbox>(find.byType(Checkbox)).onChanged, isNull);

      await tester.tap(find.byType(Checkbox), warnIfMissed: false);
      await tester.pump();
      expect(calls, 0);
    });

    testWidgets('没有回调（只读宿主）时不挂可交互的勾选框', (tester) async {
      await tester.pumpWidget(host(
        MessageBubble(
          message: userMsg(),
          showAutoCommit: true,
          autoCommitChecked: true,
        ),
      ));
      expect(tester.widget<Checkbox>(find.byType(Checkbox)).onChanged, isNull);
    });
  });

  group('ChatProvider 每轮自动提交状态', () {
    late ChatProvider provider;
    late SettingsService settings;

    setUp(() async {
      SharedPreferences.setMockInitialValues({
        'multicc_host': 'http://127.0.0.1:1',
        'multicc_token': '',
      });
      settings = await SettingsService.getInstance();
      provider = ChatProvider(
        settings: settings,
        sessionName: 's-autocommit-state',
        sessionCwd: '/tmp',
      );
    });

    tearDown(() => provider.dispose());

    test('没被手动勾过时跟随会话级开关，勾过之后以自己的值为准', () {
      expect(provider.turnAutoCommit('m-1', fallback: true), isTrue);
      expect(provider.turnAutoCommit('m-1', fallback: false), isFalse);

      provider.setTurnAutoCommit('m-1', false);
      expect(provider.turnAutoCommit('m-1', fallback: true), isFalse);

      // 换一轮：还是跟着会话走，互不串味。
      expect(provider.turnAutoCommit('m-2', fallback: true), isTrue);
    });

    test('已提交标记按消息 id 记，重复标记幂等', () {
      expect(provider.isTurnAutoCommitted('m-1'), isFalse);
      provider.markTurnAutoCommitted('m-1');
      expect(provider.isTurnAutoCommitted('m-1'), isTrue);
      expect(provider.isTurnAutoCommitted('m-2'), isFalse);
      provider.markTurnAutoCommitted('m-1');
      expect(provider.isTurnAutoCommitted('m-1'), isTrue);
    });

    test('setTurnAutoCommit / markTurnAutoCommitted 都会通知监听者', () {
      // provider 自己也可能因为连接失败等原因通知，所以只断言「涨了」，
      // 不钉死具体次数。
      var notified = 0;
      provider.addListener(() => notified++);
      final before = notified;
      provider.setTurnAutoCommit('m-1', true);
      expect(notified, greaterThan(before));
      final afterToggle = notified;
      provider.markTurnAutoCommitted('m-1');
      expect(notified, greaterThan(afterToggle));
    });
  });
}
