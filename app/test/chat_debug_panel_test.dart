import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/providers/chat_provider.dart';
import 'package:multicc_app/services/chat_debug_log.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/chat_debug_panel.dart';

/// 调试面板（Web `public/chat.html` 的 `#debug-panel`）：
/// 它的全部价值在于把「卡在 Thinking…」这个 bug 变成一个能读的签名，所以这里
/// 重点测两件事 —— 600 条上限/行格式跟 Web 一致，以及 STUCK 徽章只在
/// 「thinking 还在屏幕上、但已经不在 streaming」时出现。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => I18n.init('zh'));

  // 单例是进程级的（写日志的点散在 ChatService/ChatProvider 深处），用例之间
  // 必须换一份干净的，否则上一条用例的日志会漏到这一条。
  setUp(ChatDebugLog.reset);

  group('ChatDebugLog', () {
    test('行格式逐字对齐 Web：HH:MM:SS.mmm [cat] text', () {
      dbg('ws', 'onopen — 连接已建立');
      expect(
        ChatDebugLog.instance.entries.single.line,
        matches(RegExp(r'^\d{2}:\d{2}:\d{2}\.\d{3} \[ws\] onopen — 连接已建立$')),
      );
    });

    test('超过 600 条丢最旧的（Web 的 _DBG_MAX）', () {
      for (var i = 0; i < 601; i++) {
        dbg('state', 'e$i');
      }
      final entries = ChatDebugLog.instance.entries;
      expect(entries.length, 600);
      expect(entries.first.text, 'e1');
      expect(entries.last.text, 'e600');
    });

    test('clear 之后自己留一行 —— 否则面板一片空白，看起来像是坏了', () {
      dbg('ws', 'before');
      ChatDebugLog.instance.clear();
      expect(ChatDebugLog.instance.entries.single.text, 'debug log cleared');
      expect(ChatDebugLog.instance.entries.single.cat, 'state');
    });

    test('dump 是 Copy 按钮拷的那段文本（按行拼接）', () {
      dbg('history', 'a');
      dbg('model', 'b');
      expect(
        ChatDebugLog.instance.dump(),
        ChatDebugLog.instance.entries.map((e) => e.line).join('\n'),
      );
    });
  });

  group('徽章行（dbgState）', () {
    Future<void> pumpRow(
      WidgetTester tester, {
      String ws = 'OPEN',
      bool streaming = false,
      bool thinking = false,
      bool liveBubble = false,
      String session = '',
    }) => tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ChatDebugStateRow(
            ws: ws,
            streaming: streaming,
            thinking: thinking,
            liveBubble: liveBubble,
            session: session,
          ),
        ),
      ),
    );

    testWidgets('五个基础徽章，值跟传入一致', (tester) async {
      await pumpRow(tester, streaming: true, liveBubble: true, session: 'abcdefgh1234');
      expect(find.textContaining('ws OPEN'), findsOneWidget);
      expect(find.textContaining('streaming true'), findsOneWidget);
      expect(find.textContaining('thinking false'), findsOneWidget);
      expect(find.textContaining('msgEl true'), findsOneWidget);
      // 只取前 8 个字符，跟 Web 的 `sessionId.slice(0, 8)` 一样。
      expect(find.textContaining('session abcdefgh'), findsOneWidget);
      expect(find.textContaining('abcdefgh1'), findsNothing);
    });

    testWidgets('没有 session 时显示 -，不显示空字符串', (tester) async {
      await pumpRow(tester);
      expect(find.textContaining('session -'), findsOneWidget);
    });

    testWidgets('非 OPEN 的 ws 状态不会显示成正常（Web 里判非 OPEN 即 bad）', (tester) async {
      await pumpRow(tester, ws: 'CLOSED');
      expect(find.textContaining('ws CLOSED'), findsOneWidget);
      await pumpRow(tester, ws: 'CONNECTING');
      expect(find.textContaining('ws CONNECTING'), findsOneWidget);
    });

    testWidgets('故障签名：thinking 还在但已不 streaming -> 红色 ⚠ STUCK', (tester) async {
      await pumpRow(tester, streaming: false, thinking: true);
      expect(find.textContaining('⚠ STUCK'), findsOneWidget);
      expect(find.textContaining('thinking 显示中但已不在 streaming'), findsOneWidget);
    });

    testWidgets('正在 streaming 时不算卡住', (tester) async {
      await pumpRow(tester, streaming: true, thinking: true);
      expect(find.textContaining('⚠ STUCK'), findsNothing);
    });
  });

  group('ChatDebugPanel', () {
    late SettingsService settings;
    late ChatProvider provider;

    Future<void> pumpPanel(WidgetTester tester, {required bool open}) async {
      await tester.pumpWidget(
        ChangeNotifierProvider<ChatProvider>.value(
          value: provider,
          child: MaterialApp(
            home: Scaffold(
              body: Stack(
                children: [
                  Positioned.fill(
                    child: ChatDebugPanel(open: open, onClose: () {}),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    }

    setUp(() async {
      SharedPreferences.setMockInitialValues({
        'multicc_host': 'http://127.0.0.1:1',
        'multicc_token': '',
      });
      settings = await SettingsService.getInstance();
      provider = ChatProvider(
        settings: settings,
        sessionName: 's-dbg',
        sessionCwd: '/tmp',
      );
    });

    tearDown(() => provider.dispose());

    testWidgets('开着时才滑进来，关着时滑出屏幕之外', (tester) async {
      await pumpPanel(tester, open: false);
      expect(
        tester.widget<AnimatedSlide>(find.byType(AnimatedSlide)).offset,
        const Offset(1.05, 0),
      );
      await pumpPanel(tester, open: true);
      expect(
        tester.widget<AnimatedSlide>(find.byType(AnimatedSlide)).offset,
        Offset.zero,
      );
    });

    testWidgets('打开后能看到日志行，以及头部的 Debug 标题', (tester) async {
      dbg('ws', 'onopen — 连接已建立');
      await pumpPanel(tester, open: true);
      expect(find.text('🐛 Debug'), findsOneWidget);
      expect(find.textContaining('[ws]'), findsOneWidget);
      expect(find.textContaining('onopen — 连接已建立'), findsOneWidget);
    });

    testWidgets('Clear 清空并留下一行 debug log cleared', (tester) async {
      dbg('ws', 'before');
      await pumpPanel(tester, open: true);
      await tester.tap(find.text(t('clearBtn')));
      await tester.pump();
      expect(find.textContaining('before'), findsNothing);
      expect(find.textContaining('debug log cleared'), findsOneWidget);
    });

    testWidgets('Copy 把整段 dump 写进剪贴板，按钮临时变成 Copied', (tester) async {
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied = (call.arguments as Map)['text'] as String?;
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );

      dbg('ws', 'hello');
      final expected = ChatDebugLog.instance.dump();
      await pumpPanel(tester, open: true);
      await tester.tap(find.text(t('copy')));
      await tester.pump();

      expect(copied, expected);
      expect(copied, contains('[ws] hello'));
      expect(find.text('Copied'), findsOneWidget);

      // 文案 1.5s 后还原（Web 的 setTimeout(1500)）—— 顺带把定时器跑完，
      // 免得留在测试结束时变成 pending timer。
      await tester.pump(const Duration(milliseconds: 1600));
      expect(find.text(t('copy')), findsOneWidget);
    });
  });
}
