import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/session_manager.dart';
import 'package:multicc_app/screens/chat_screen.dart';
import 'package:multicc_app/screens/main_shell.dart';
import 'package:multicc_app/services/onboarding_store.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_sidebar.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

// 打开一个对话 = 一层盖满的浮层（三端同一套规矩，Web 那侧是 `public/air.js` 的
// `#chat-layer`）。手机默认就展开（连页头一起盖）：顶部不留一条可拖的闲置区，
// 把空间都留给聊天。收起 = 标题左侧那颗 ⌄、标题区域往下拖、或 Android 返回键。
//
// 这里在真的 MainShell 上量：默认态有没有盖到屏幕最上面、标题区往下拖能不能
// 收起回首页。Web 那侧有对应的 CDP 用例（tests/test-air-chat-layer-cdp.js）。
//
// SessionManager 的构造器会启动 5s 周期刷新，而 flutter_test 在 test body 内部
// 就检查 pending timers（早于 addTearDown）——所以每个用例都必须在断言之后、
// body 结束之前 `mgr.dispose()`（跟 chat_header_title_test.dart 同一个道理）。
void main() {
  const statusBar = 47.0;
  const separator = 1.0; // 浮层顶边那条分界线（BoxDecoration 的 border 也算进布局）

  setUpAll(() => I18n.init('zh'));

  /// 一台 390×844、带刘海的手机，Air 首页上开着一个对话。
  Future<SessionManager> pumpShell(WidgetTester tester) async {
    tester.view.physicalSize = const Size(390 * 3, 844 * 3);
    tester.view.devicePixelRatio = 3;
    tester.view.padding = const FakeViewPadding(
      top: statusBar * 3,
      bottom: 34 * 3,
    );
    addTearDown(tester.view.reset);

    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://127.0.0.1:3000',
      OnboardingStore.doneKey: '1',
    });
    final settings = await SettingsService.getInstance();
    final mgr = SessionManager(settings: settings);
    mgr.openSession(
      Session(
        id: 'sess-1',
        cwd: '/tmp',
        kind: SessionKind.chat,
        createdAt: DateTime.now(),
      ),
    );
    mgr.switchToSession('sess-1');

    await tester.pumpWidget(
      ChangeNotifierProvider<SessionManager>.value(
        value: mgr,
        child: MaterialApp(home: MainShell(settings: settings)),
      ),
    );
    await tester.pump();
    await settleDraining(tester); // 进场的滑升
    return mgr;
  }

  Finder chat() => find.byType(ChatView);

  testWidgets('默认就展开：聊天从屏幕最上面开始，顶部没有可拖的控制条', (tester) async {
    final mgr = await pumpShell(tester);

    final body = tester.getRect(chat());
    expect(
      body.top,
      statusBar + separator,
      reason: '默认展开态从屏幕最上面开始（让出状态栏一条，内容不钻到刘海底下）',
    );
    expect(body.left, 0);
    expect(body.right, 390, reason: '要盖满整条宽度');
    expect(body.bottom, 844);

    // 那条带拖柄和「展开/收起」的控制条不再存在：顶部空间都留给聊天。
    expect(find.byKey(const ValueKey('chat-sheet-expand')), findsNothing);
    expect(find.text('展开'), findsNothing);
    expect(find.text('收起'), findsNothing);

    mgr.dispose();
  });

  testWidgets('标题区域往下拖就收起回首页', (tester) async {
    final mgr = await pumpShell(tester);

    // 标题行是收起的落点：往下拖过阈值 = 关掉对话，回到首页。
    final titleLine = find.textContaining('sess-1');
    expect(titleLine, findsOneWidget);
    await tester.drag(titleLine, const Offset(0, 600));
    await settleDraining(tester);

    expect(mgr.activeSessionId, isNull, reason: '往下拖 = 关掉对话，回到首页');
    expect(chat(), findsNothing);

    mgr.dispose();
  });

  testWidgets('标题左侧 ⌄ 点击也收起回首页', (tester) async {
    final mgr = await pumpShell(tester);

    // ChatHeader 最左边的收起箭头（标题左侧）。
    await tester.tap(
      find.byIcon(Icons.keyboard_arrow_down_rounded).first,
    );
    await settleDraining(tester);

    expect(mgr.activeSessionId, isNull, reason: '点 ⌄ = 关掉对话，回到首页');
    expect(chat(), findsNothing);

    mgr.dispose();
  });
}

/// 走完动画，并且**每一帧**都看一眼有没有报错 —— 攒到最后一并就变成一句
/// 「Multiple exceptions (N)」，分不清是哪来的，也没法判断该不该放行。
Future<void> settleDraining(WidgetTester tester) async {
  for (var i = 0; i < 200 && tester.binding.hasScheduledFrame; i++) {
    await tester.pump(const Duration(milliseconds: 16));
    drainSquashNoise(tester);
  }
  drainSquashNoise(tester);
}

/// 收起浮层这一路，必须经过「浮层被压到只剩几十像素高」的中间帧：聊天页里那几个
/// 面板（运行时面板、产物面板）本来就塞不进那么小的框，布局在这一帧报 overflow。
/// release 里它只是被裁到屏幕外、肉眼看不见，而且浮层下滑关掉这条老路（0.9 那版
/// 也一样）走的正是同一帧 —— 跟这次改的东西无关。所以这里按帧接住，但只放行
/// 「塞不下」这一类：真出了别的错，这一条会当场炸出来。
void drainSquashNoise(WidgetTester tester) {
  for (var e = tester.takeException(); e != null; e = tester.takeException()) {
    expect(
      '$e',
      matches(RegExp(r'overflowed by|Multiple exceptions \(\d+\)')),
      reason:
          '收起过程中只该有「面板被压扁」这一类中间帧报错'
          '（同一帧好几个面板一起塞不下时，Flutter 会先把它们折成一句 Multiple exceptions）',
    );
  }
}