import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/chat_provider.dart';
import 'package:multicc_app/services/message_quote.dart';
import 'package:multicc_app/services/quota_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/message_bubble.dart';

// 引用功能的**入口**：气泡长按弹层里的「引用这条消息」。
//
// 这一条最值得单独测，因为它没有会自己报错的形态：输入框通道（provider 的
// quoteInserter）没人登记，弹层里就少一行 —— 不抛错、不留痕，功能静悄悄地没
// 了。所以这里既测「有输入框时给得出来」，也测「没输入框时根本别摆」。

class _Quota extends QuotaService {
  _Quota(SettingsService settings) : super(settings: settings);
  @override
  Future<Map<String, dynamic>?> fetchCodexQuota() async => null;
  @override
  Future<Map<String, dynamic>?> fetchIdleBars() async => null;
}

/// 一个连不通任何地方的 provider：这里关心的是弹层怎么决定，不是网络。主机指向
/// 一个几乎不可能在监听的端口，失败只会走重连退避 —— 测试里 pump 的量级够不到
/// 第一次退避。
///
/// 用完必须 [ChatProvider.dispose] 掉，且要在**测试体内**：它带着待决的退避/
/// 重试定时器，留给 teardown 的话，flutter_test 的「树已销毁但还有定时器在跑」
/// 不变量会先炸。
Future<ChatProvider> idleProvider() async {
  SharedPreferences.setMockInitialValues({});
  final settings = await SettingsService.getInstance();
  await settings.save(host: 'http://127.0.0.1:9', token: '');
  return ChatProvider(
    settings: settings,
    sessionName: 'source',
    sessionCwd: '/fixture',
    initialCli: SessionCli.claude,
    quotaService: _Quota(settings),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  ChatMessage row({required String content, String? id = 'source:m_1'}) =>
      ChatMessage(
        role: MessageRole.assistant,
        content: content,
        id: id,
        sourceSessionId: 'source',
        sourceMessageId: 'm_1',
        taskId: 'tsk_1',
        taskName: '完善登录页面',
        timestamp: DateTime(2026, 9, 14, 9, 30),
      );

  /// 长按气泡直接调它的 onLongPress：markdown 正文上的像素级手势在测试环境里
  /// 不稳（字体度量），而这里要测的是「弹层里有什么」。
  Future<void> openSheet(WidgetTester tester) async {
    final gd = tester.widget<GestureDetector>(
      find.descendant(
        of: find.byType(MessageBubble),
        matching: find.byType(GestureDetector),
      ),
    );
    gd.onLongPress!();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  Future<void> host(
    WidgetTester tester,
    ChatProvider provider,
    ChatMessage message,
  ) => tester.pumpWidget(
    ChangeNotifierProvider<ChatProvider>.value(
      value: provider,
      child: MaterialApp(
        home: Scaffold(body: MessageBubble(message: message)),
      ),
    ),
  );

  testWidgets('有输入框时，弹层里能引用，并把引用块交给输入框', (tester) async {
    final provider = await idleProvider();
    final inserted = <String>[];
    provider.quoteInserter = inserted.add;
    try {
      await host(tester, provider, row(content: '登录接口已经改成走统一网关。'));
      await openSheet(tester);

      expect(find.text('引用这条消息'), findsOneWidget);
      await tester.tap(find.text('引用这条消息'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(inserted, hasLength(1));
      expect(inserted.single, contains('任务「完善登录页面」（tsk_1）'));
      expect(inserted.single, contains('source:m_1'));
      expect(inserted.single, contains('> 登录接口已经改成走统一网关。'));
    } finally {
      provider.dispose();
    }
  });

  testWidgets('没有输入框的宿主压根不摆这个入口', (tester) async {
    final provider = await idleProvider();
    try {
      await host(tester, provider, row(content: '登录接口已经改成走统一网关。'));
      await openSheet(tester);

      expect(find.text('复制内容'), findsOneWidget);
      expect(find.text('引用这条消息'), findsNothing);
    } finally {
      provider.dispose();
    }
  });

  testWidgets('还没落库的消息：说清楚引用不了，而不是编一个身份', (tester) async {
    final provider = await idleProvider();
    final inserted = <String>[];
    provider.quoteInserter = inserted.add;
    try {
      await host(tester, provider, row(content: '正在写的一半…', id: null));
      await openSheet(tester);

      await tester.tap(find.text('引用这条消息'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(inserted, isEmpty);
      expect(find.text('这条消息还没有落库，暂时引用不了'), findsOneWidget);
    } finally {
      provider.dispose();
    }
  });

  testWidgets('空白消息不给引用入口', (tester) async {
    final provider = await idleProvider();
    provider.quoteInserter = (_) {};
    try {
      await host(tester, provider, row(content: '   '));
      await openSheet(tester);

      expect(find.text('引用这条消息'), findsNothing);
    } finally {
      provider.dispose();
    }
  });

  test('引用块与输入框草稿的合并规则', () {
    expect(composerTextWithQuote('', '> 块'), '> 块\n\n');
    expect(composerTextWithQuote('原草稿', '> 块'), '> 块\n\n原草稿');
  });
}
